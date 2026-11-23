import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type PassiveSearchBatch,
  type ProjectedGraphQLJob,
  WsSearchObservedNotificationSchema,
} from '../shared/protocol';
import { LiveSearchStream } from './live-search-stream';

function makeBatch(overrides: Partial<PassiveSearchBatch> = {}): PassiveSearchBatch {
  return {
    captureSeq: 1,
    navigationEpoch: 1,
    captureKind: 'graphql',
    requestUrl: 'https://www.upwork.com/api/graphql/v1',
    pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=golang',
    operationName: 'UserJobSearchV1',
    sourceFeed: 'search',
    query: 'golang',
    jobs: [
      {
        upwork_job_id: '~011111111111111111',
        job_title: 'Senior Go Engineer',
        job_description: 'Build distributed services in Go.',
        contract_type: 'hourly',
        rate_min: '$70',
        rate_max: '$110',
        rate_range: '$70 - $110',
        budget: '$70 - $110/hr',
        connects_required: 12,
        posted_at_est: '2026-11-22T20:00:00.000Z',
        client_country: 'United States',
        payment_verified: true,
      },
    ],
    paging: {
      totalCount: 40,
      offset: 0,
      count: 10,
      page: 1,
      perPage: 10,
      hasNextPage: true,
      nextCursor: 'cursor-2',
    },
    capturedAt: '2026-11-22T20:01:00.000Z',
    ...overrides,
  };
}

describe('LiveSearchStream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('caches up to maxCachedBatchesPerTab per tab, filters by sinceIso, and clears cache + pending timers on clearTab', () => {
    const sendWsNotification = vi.fn(() => true);
    const stream = new LiveSearchStream({
      getTabControllerState: () => ({ automationTabId: null, busy: false }),
      isKillSwitchActive: () => false,
      sendWsNotification,
      maxCachedBatchesPerTab: 10,
    });

    for (let i = 1; i <= 12; i++) {
      const minute = String(i).padStart(2, '0');
      stream.handleIncomingBatch(
        7,
        makeBatch({
          captureSeq: i,
          capturedAt: `2026-11-22T20:${minute}:00.000Z`,
          jobs: [{ upwork_job_id: `~01000000000000000${i}`, job_title: `Job ${i}` }],
        }),
      );
    }

    const all = stream.getBatchesForTab(7);
    expect(all).toHaveLength(10);
    expect(all[0]?.captureSeq).toBe(3);
    expect(all[9]?.captureSeq).toBe(12);

    const since = stream.getBatchesForTab(7, '2026-11-22T20:10:00.000Z');
    expect(since.map((b) => b.captureSeq)).toEqual([10, 11, 12]);

    // Pending debounce timer for tab 7 must be cancelled on clearTab(7)
    stream.clearTab(7);
    expect(stream.getBatchesForTab(7)).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(sendWsNotification).not.toHaveBeenCalled();
  });

  it('caches batches for busy automation tab while suppressing WS push, and pushes normally when idle or on user tab', () => {
    let tabState: { automationTabId: number | null; busy: boolean } = {
      automationTabId: 42,
      busy: true,
    };
    const sendWsNotification = vi.fn(() => true);
    const stream = new LiveSearchStream({
      getTabControllerState: () => tabState,
      isKillSwitchActive: () => false,
      sendWsNotification,
    });

    // Busy automation tab: cached, suppressed
    const suppressedRes = stream.handleIncomingBatch(42, makeBatch());
    expect(suppressedRes).toEqual({
      cached: true,
      queued: false,
      suppressedReason: 'active_sweep',
    });
    expect(stream.getBatchesForTab(42)).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(sendWsNotification).not.toHaveBeenCalled();

    // User tab (99) while automation tab (42) is busy -> pushes normally
    const userRes = stream.handleIncomingBatch(99, makeBatch());
    expect(userRes).toEqual({ cached: true, queued: true });
    vi.advanceTimersByTime(400);
    expect(sendWsNotification).toHaveBeenCalledTimes(1);

    // Same job on automation tab after sweep completes (busy=false) with new job ID -> pushes normally
    tabState = { automationTabId: 42, busy: false };
    const idleRes = stream.handleIncomingBatch(
      42,
      makeBatch({
        jobs: [{ upwork_job_id: '~022222222222222222', job_title: 'Idle Tab Job' }],
      }),
    );
    expect(idleRes).toEqual({ cached: true, queued: true });
    vi.advanceTimersByTime(400);
    expect(sendWsNotification).toHaveBeenCalledTimes(2);
  });

  it('suppresses WS push on kill switch, isLiveStreamEnabled=false, graphqlErrorCodes, and re-checks inside flush', () => {
    let killSwitch = false;
    let enabled = true;
    const sendWsNotification = vi.fn(() => true);
    const stream = new LiveSearchStream({
      getTabControllerState: () => ({ automationTabId: null, busy: false }),
      isKillSwitchActive: () => killSwitch,
      isLiveStreamEnabled: () => enabled,
      sendWsNotification,
    });

    // 1. GraphQL error batch -> cached but suppressed
    const errRes = stream.handleIncomingBatch(
      1,
      makeBatch({ graphqlErrorCodes: ['UNAUTHENTICATED'] }),
    );
    expect(errRes).toEqual({
      cached: true,
      queued: false,
      suppressedReason: 'graphql_error',
    });

    // 2. isLiveStreamEnabled() === false -> cached but suppressed
    enabled = false;
    const disabledRes = stream.handleIncomingBatch(1, makeBatch());
    expect(disabledRes).toEqual({
      cached: true,
      queued: false,
      suppressedReason: 'disabled',
    });
    enabled = true;

    // 3. Kill switch activated mid-debounce -> flush aborts without sending
    stream.handleIncomingBatch(1, makeBatch());
    killSwitch = true;
    vi.advanceTimersByTime(400);
    expect(sendWsNotification).not.toHaveBeenCalled();

    // 4. Direct kill switch on incoming batch
    const ksRes = stream.handleIncomingBatch(1, makeBatch());
    expect(ksRes).toEqual({
      cached: true,
      queued: false,
      suppressedReason: 'kill_switch',
    });

    // 5. cancelPendingFlushes clears queued debounce timers
    killSwitch = false;
    stream.handleIncomingBatch(
      2,
      makeBatch({
        jobs: [{ upwork_job_id: '~033333333333333333', job_title: 'Queued Job' }],
      }),
    );
    stream.cancelPendingFlushes();
    vi.advanceTimersByTime(500);
    expect(sendWsNotification).not.toHaveBeenCalled();
  });

  it('debounces and coalesces chunks for same (tabId, sourceFeed, query) while isolating distinct keys', () => {
    const sentFrames: Array<{ method: string; params: Record<string, unknown> }> = [];
    const stream = new LiveSearchStream({
      getTabControllerState: () => ({ automationTabId: null, busy: false }),
      isKillSwitchActive: () => false,
      sendWsNotification: (method, params) => {
        sentFrames.push({ method, params });
        return true;
      },
    });

    // Chunk 1 (golang) and separate key (rust) both queued at t=0
    stream.handleIncomingBatch(
      5,
      makeBatch({
        captureSeq: 1,
        chunkIndex: 0,
        chunkCount: 2,
        jobs: [{ upwork_job_id: '~0111', job_title: 'Job A' }],
      }),
    );
    stream.handleIncomingBatch(
      5,
      makeBatch({
        captureSeq: 3,
        query: 'rust',
        jobs: [{ upwork_job_id: '~0333', job_title: 'Rust Job' }],
      }),
    );

    // Chunk 2 (golang) arrives at t=200 -> resets golang timer to t=600, leaving rust at t=400
    vi.advanceTimersByTime(200);
    stream.handleIncomingBatch(
      5,
      makeBatch({
        captureSeq: 2,
        chunkIndex: 1,
        chunkCount: 2,
        jobs: [
          { upwork_job_id: '~0111', job_title: 'Job A', job_description: 'Enriched desc' },
          { upwork_job_id: '~0222', job_title: 'Job B' },
        ],
      }),
    );

    // At t=400, rust flushes (400ms elapsed); golang is still waiting (200ms since chunk 2)
    vi.advanceTimersByTime(200);
    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]?.params.query).toBe('rust');

    // At t=600, coalesced golang frame flushes
    vi.advanceTimersByTime(200);
    expect(sentFrames).toHaveLength(2);
    expect(sentFrames[1]?.params.query).toBe('golang');
    const goJobs = sentFrames[1]?.params.jobs as Array<Record<string, unknown>>;
    expect(goJobs).toHaveLength(2);
    expect(goJobs[0]?.job_description).toBe('Enriched desc');
  });

  it('enforces 5-min TTL dedup, rich-field refresh, and offline safety when sendWsNotification returns false', () => {
    let now = 1_700_000_000_000;
    let wsOnline = false;
    const sentFrames: Array<Record<string, unknown>> = [];

    const stream = new LiveSearchStream({
      getTabControllerState: () => ({ automationTabId: null, busy: false }),
      isKillSwitchActive: () => false,
      sendWsNotification: (_method, params) => {
        if (!wsOnline) {
          return false;
        }
        sentFrames.push(params);
        return true;
      },
      nowFn: () => now,
      dedupTtlMs: 5 * 60_000,
    });

    const baseJob: ProjectedGraphQLJob = {
      upwork_job_id: '~0999',
      job_title: 'Base Job',
    };

    // Offline attempt: sendWsNotification returns false -> must NOT poison dedup cache
    stream.handleIncomingBatch(1, makeBatch({ jobs: [baseJob] }));
    vi.advanceTimersByTime(400);
    expect(sentFrames).toHaveLength(0);

    // WS reconnects -> same job now succeeds
    wsOnline = true;
    stream.handleIncomingBatch(1, makeBatch({ jobs: [baseJob] }));
    vi.advanceTimersByTime(400);
    expect(sentFrames).toHaveLength(1);

    // Duplicate within TTL -> dropped
    now += 60_000;
    const dupRes = stream.handleIncomingBatch(1, makeBatch({ jobs: [baseJob] }));
    expect(dupRes.suppressedReason).toBe('deduped');
    vi.advanceTimersByTime(400);
    expect(sentFrames).toHaveLength(1);

    // Rich-field refresh: connects_required newly populated within TTL -> re-pushed
    now += 30_000;
    stream.handleIncomingBatch(1, makeBatch({ jobs: [{ ...baseJob, connects_required: 16 }] }));
    vi.advanceTimersByTime(400);
    expect(sentFrames).toHaveLength(2);

    // Rich-field refresh: job_description newly populated within TTL -> re-pushed
    now += 30_000;
    stream.handleIncomingBatch(
      1,
      makeBatch({
        jobs: [{ ...baseJob, connects_required: 16, job_description: 'Full description' }],
      }),
    );
    vi.advanceTimersByTime(400);
    expect(sentFrames).toHaveLength(3);

    // Duplicate again with same rich fields within TTL -> dropped
    now += 30_000;
    const dupRich = stream.handleIncomingBatch(
      1,
      makeBatch({
        jobs: [{ ...baseJob, connects_required: 16, job_description: 'Full description' }],
      }),
    );
    expect(dupRich.suppressedReason).toBe('deduped');

    // After TTL expires -> re-pushed
    now += 5 * 60_000;
    stream.handleIncomingBatch(
      1,
      makeBatch({
        jobs: [{ ...baseJob, connects_required: 16, job_description: 'Full description' }],
      }),
    );
    vi.advanceTimersByTime(400);
    expect(sentFrames).toHaveLength(4);
  });

  it('serializes snake_case search.observed frames valid against WsSearchObservedNotificationSchema and records activity', () => {
    const sentNotifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    const activityEntries: Array<Record<string, unknown>> = [];

    const stream = new LiveSearchStream({
      getTabControllerState: () => ({ automationTabId: null, busy: false }),
      isKillSwitchActive: () => false,
      sendWsNotification: (method, params) => {
        sentNotifications.push({ method, params });
        return true;
      },
      recordActivity: (entry) => {
        activityEntries.push(entry as unknown as Record<string, unknown>);
      },
    });

    stream.handleIncomingBatch(
      15,
      makeBatch({
        sourceFeed: 'best_matches',
        query: '',
        operationName: '',
        paging: {
          totalCount: 100,
          offset: 10,
          count: 10,
          page: 2,
          perPage: 10,
          hasNextPage: true,
          nextCursor: '',
        },
        jobs: [
          {
            upwork_job_id: '~088888888888888888',
            job_title: 'TypeScript Lead',
            posted_at_est: '',
            connects_required: 8,
            payment_verified: true,
          },
        ],
      }),
    );

    vi.advanceTimersByTime(400);
    expect(sentNotifications).toHaveLength(1);
    const notif = sentNotifications[0];
    expect(notif?.method).toBe('search.observed');

    const fullFrame = {
      jsonrpc: '2.0',
      method: notif?.method,
      params: notif?.params,
    };
    const parsed = WsSearchObservedNotificationSchema.safeParse(fullFrame);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.params.tab_id).toBe(15);
      expect(parsed.data.params.source_feed).toBe('best_matches');
      expect(parsed.data.params.query).toBeUndefined();
      expect(parsed.data.params.operation_name).toBeUndefined();
      expect(parsed.data.params.paging).toEqual({
        total_count: 100,
        offset: 10,
        count: 10,
        page: 2,
        per_page: 10,
        has_next_page: true,
      });
      const job = parsed.data.params.jobs[0];
      expect(job?.source).toBe('chrome_live_stream');
      expect(job?.source_feed).toBe('best_matches');
      expect(job?.source_query).toBeUndefined();
      expect(job?.canonical_url).toBe('https://www.upwork.com/jobs/~088888888888888888/');
      expect(job?.url).toBe('https://www.upwork.com/jobs/~088888888888888888/');
      expect(job?.job_url).toBe('https://www.upwork.com/jobs/~088888888888888888/');
      expect(job?.status).toBe('ready');
      expect(job?.posted_at_est).toBeUndefined();
    }

    expect(activityEntries).toHaveLength(1);
    expect(activityEntries[0]?.action).toBe('search.observed');
  });

  it('skips titleless metadata-only jobs while flushing titled jobs in the same batch normally', () => {
    const sentFrames: Array<Record<string, unknown>> = [];
    const stream = new LiveSearchStream({
      getTabControllerState: () => ({ automationTabId: null, busy: false }),
      isKillSwitchActive: () => false,
      sendWsNotification: (_method, params) => {
        sentFrames.push(params);
        return true;
      },
    });

    // Batch with only titleless jobs is cached but not queued
    const onlyTitleless = stream.handleIncomingBatch(
      21,
      makeBatch({
        jobs: [
          { upwork_job_id: '~077777777777777701', connects_required: 8 },
          { upwork_job_id: '~077777777777777702', job_title: '   ' },
        ],
      }),
    );
    expect(onlyTitleless.cached).toBe(true);
    expect(onlyTitleless.queued).toBe(false);
    vi.advanceTimersByTime(400);
    expect(sentFrames).toHaveLength(0);

    // Mixed batch drops titleless fragments and flushes titled job
    const mixed = stream.handleIncomingBatch(
      21,
      makeBatch({
        jobs: [
          { upwork_job_id: '~077777777777777701', connects_required: 8 },
          { upwork_job_id: '~077777777777777703', job_title: 'Titled Rust Engineer' },
        ],
      }),
    );
    expect(mixed).toEqual({ cached: true, queued: true });
    vi.advanceTimersByTime(400);
    expect(sentFrames).toHaveLength(1);
    const jobs = sentFrames[0]?.jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.upwork_job_id).toBe('~077777777777777703');
  });
});
