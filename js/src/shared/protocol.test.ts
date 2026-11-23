import { describe, expect, it } from 'vitest';
import {
  BackgroundCommandMessageSchema,
  BridgeErrorCodeSchema,
  ContentGuardCheckRequestSchema,
  KillSwitchAbortResultSchema,
  PASSIVE_SEARCH_BATCH_EVENT,
  PASSIVE_SEARCH_STATUS_EVENT,
  PASSIVE_SPA_NAV_EVENT,
  PassiveSearchBatchSchema,
  PassiveTapPayloadSchema,
  ProjectedGraphQLJobSchema,
  SearchPaginationMetaSchema,
  SessionStatusResultSchema,
  TabsListResultSchema,
  WsAuthRequestSchema,
  WsAuthSuccessResponseSchema,
  WsPingSchema,
  WsPongSchema,
  WsRpcRequestSchema,
  WsSearchObservedNotificationSchema,
  WsTaskProgressSchema,
} from './protocol';
import {
  ExtensionSettingsSchema,
  JobUpsertPayloadSchema,
  MessageItemSchema,
  MessageThreadSchema,
  ProposalDraftSchema,
  SearchRunFiltersSchema,
  SearchRunRequestSchema,
} from './schemas';
import { BUNDLED_SELECTORS, SelectorConfigSchema } from './selectors';

describe('M3 Shared Zod v4 Protocol & Schemas', () => {
  it('validates BUNDLED_SELECTORS against SelectorConfigSchema', () => {
    const parsed = SelectorConfigSchema.safeParse(BUNDLED_SELECTORS);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe('2.0');
      expect(Object.keys(parsed.data.views)).toEqual(
        expect.arrayContaining([
          'search_listings',
          'best_matches',
          'most_recent',
          'saved_jobs',
          'job_detail',
          'proposal_apply',
          'proposals_list',
          'messages_rooms',
          'messages_thread',
        ]),
      );
    }
  });

  it('validates WS JSON-RPC auth, ping/pong, progress, and RPC result envelopes', () => {
    expect(
      WsAuthRequestSchema.safeParse({
        jsonrpc: '2.0',
        id: 'auth-1',
        method: 'auth',
        params: { token: 'abc', extension_version: '2.0.0', browser: 'chrome' },
      }).success,
    ).toBe(true);

    expect(
      WsAuthSuccessResponseSchema.safeParse({
        jsonrpc: '2.0',
        id: 'auth-1',
        result: { ok: true, session_id: 'ext-1234' },
      }).success,
    ).toBe(true);

    expect(WsPingSchema.safeParse({ jsonrpc: '2.0', method: 'ping' }).success).toBe(true);
    expect(WsPongSchema.safeParse({ jsonrpc: '2.0', method: 'pong' }).success).toBe(true);
    expect(
      WsTaskProgressSchema.safeParse({
        jsonrpc: '2.0',
        method: 'task.progress',
        params: { request_id: 'rpc-1', stage: 'enrich', current: 2, total: 5 },
      }).success,
    ).toBe(true);

    expect(
      SessionStatusResultSchema.safeParse({
        ok: true,
        extension_connected: true,
        extension_version: '2.0.0',
        browser: 'chrome',
        upwork_logged_in: true,
        automation_tab_id: 42,
        busy: false,
        active_request_id: null,
        kill_switch_active: false,
        last_error: null,
      }).success,
    ).toBe(true);

    expect(
      TabsListResultSchema.safeParse({
        tabs: [
          {
            id: 1,
            title: 'Upwork',
            url: 'https://www.upwork.com/nx/search/jobs/',
            active: true,
            automation: false,
            is_automation: false,
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      KillSwitchAbortResultSchema.safeParse({
        aborted: true,
        active_request_id: 'rpc-9',
        reason: 'User triggered kill switch',
      }).success,
    ).toBe(true);
  });

  it('rejects malformed JSON-RPC frames and invalid error codes', () => {
    expect(
      WsAuthRequestSchema.safeParse({
        jsonrpc: '1.0',
        id: 'auth-1',
        method: 'auth',
        params: { token: '', extension_version: '2.0.0', browser: 'chrome' },
      }).success,
    ).toBe(false);

    expect(
      WsRpcRequestSchema.safeParse({
        jsonrpc: '2.0',
        id: null,
        method: '',
      }).success,
    ).toBe(false);

    expect(BridgeErrorCodeSchema.safeParse('HUMAN_ACTION_REQUIRED').success).toBe(true);
    expect(BridgeErrorCodeSchema.safeParse('UNKNOWN_FAKE_CODE').success).toBe(false);
  });

  it('validates domain schemas and background command union', () => {
    expect(
      JobUpsertPayloadSchema.safeParse({
        job_title: 'Go Developer',
        url: 'https://www.upwork.com/jobs/~022115332344639171/',
        skills: ['Go', 'PostgreSQL'],
      }).success,
    ).toBe(true);

    expect(
      ProposalDraftSchema.safeParse({
        upwork_job_id: '~022115332344639171',
        cover_letter: 'Hello',
        bid_type: 'fixed',
        bid_amount: 1200,
        status: 'pending_approval',
      }).success,
    ).toBe(true);

    expect(
      MessageThreadSchema.safeParse({
        upwork_room_id: 'room-1',
        client_name: 'Alice',
        unread_count: 2,
        last_message_snippet: 'Hi there',
      }).success,
    ).toBe(true);

    expect(
      MessageItemSchema.safeParse({
        sender: 'Alice',
        sender_role: 'client',
        body: 'Can we start Monday?',
        status: 'received',
      }).success,
    ).toBe(true);

    expect(
      ExtensionSettingsSchema.safeParse({
        apiBaseUrl: 'http://127.0.0.1:9090',
        apiToken: 'tok-123',
        pacingSeconds: 4.5,
        jitterRatio: 0.5,
      }).success,
    ).toBe(true);

    expect(
      BackgroundCommandMessageSchema.safeParse({
        type: 'PAIR_AND_RECONNECT',
        apiBaseUrl: 'http://127.0.0.1:9090',
        apiToken: 'tok-123',
      }).success,
    ).toBe(true);
  });

  it('validates M2 SearchRunFiltersSchema and SearchRunRequestSchema criteria and bounds', () => {
    expect(
      SearchRunFiltersSchema.safeParse({
        hourly_rate_min: 60,
        hourly_rate_max: 120,
        payment_verified_only: true,
      }).success,
    ).toBe(true);

    expect(
      SearchRunFiltersSchema.safeParse({
        hourly_rate_min: 120,
        hourly_rate_max: 60,
      }).success,
    ).toBe(false);

    const parsed = SearchRunRequestSchema.safeParse({
      queries: ['Go PostgreSQL'],
      hourly_rate_min: 0,
      hourly_rate_max: 95.5,
      payment_verified_only: true,
      run_label: 'Nightly sweep',
      skip_auto_detail_enrich: true,
      from_active_projects: true,
      active_project_keys: ['upwork-buddy'],
      active_project_tiers: ['active', 'recent'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.run_label).toBe('Nightly sweep');
      expect(parsed.data.skip_auto_detail_enrich).toBe(true);
      expect(parsed.data.from_active_projects).toBe(true);
      expect(parsed.data.active_project_keys).toEqual(['upwork-buddy']);
      expect(parsed.data.active_project_tiers).toEqual(['active', 'recent']);
    }

    expect(
      SearchRunRequestSchema.safeParse({
        hourly_rate_min: -5,
      }).success,
    ).toBe(false);

    expect(
      SearchRunRequestSchema.safeParse({
        hourly_rate_min: 100,
        hourly_rate_max: 50,
      }).success,
    ).toBe(false);
  });

  it('re-exports passive search event constants and validates PassiveTapPayload truncation fields', () => {
    expect(PASSIVE_SEARCH_BATCH_EVENT).toBe('upwork-buddy:passive-search-batch');
    expect(PASSIVE_SPA_NAV_EVENT).toBe('upwork-buddy:passive-spa-nav');
    expect(PASSIVE_SEARCH_STATUS_EVENT).toBe('upwork-buddy:passive-search-status');

    expect(
      PassiveTapPayloadSchema.safeParse({
        kind: 'graphql',
        url: 'https://www.upwork.com/api/graphql/v1',
        data: { ok: true },
        capturedAt: '2026-11-22T23:00:00.000Z',
      }).success,
    ).toBe(true);

    const truncated = PassiveTapPayloadSchema.safeParse({
      kind: 'graphql',
      url: 'https://www.upwork.com/api/graphql/v1',
      operationName: 'userJobSearchV1',
      data: { __projected: true, topKeys: ['data'] },
      capturedAt: '2026-11-22T23:00:00.000Z',
      truncated: true,
      originalBytes: 1_250_000,
    });
    expect(truncated.success).toBe(true);
    if (truncated.success) {
      expect(truncated.data.truncated).toBe(true);
      expect(truncated.data.originalBytes).toBe(1_250_000);
    }

    expect(
      PassiveTapPayloadSchema.safeParse({
        kind: 'graphql',
        url: 'https://www.upwork.com/api/graphql/v1',
        data: {},
        capturedAt: '2026-11-22T23:00:00.000Z',
        originalBytes: -1,
      }).success,
    ).toBe(false);

    expect(
      BackgroundCommandMessageSchema.safeParse({
        type: 'PASSIVE_TAP_PAYLOAD',
        kind: 'xhr',
        url: 'https://www.upwork.com/ab/jobs/search/',
        data: {},
        capturedAt: '2026-11-22T23:00:00.000Z',
        truncated: true,
        originalBytes: 750_000,
      }).success,
    ).toBe(true);
  });

  it('validates ProjectedGraphQLJobSchema, SearchPaginationMetaSchema, PassiveSearchBatchSchema, and PASSIVE_SEARCH_BATCH', () => {
    const sampleJob = {
      upwork_job_id: '~022115332344639171',
      job_title: 'Go Backend Engineer',
      contract_type: 'fixed' as const,
      budget: '$1,500 fixed',
      budget_amount: '$1,500',
      posted_at_est: '2026-11-22T22:00:00.000Z',
      proposals_count: 4,
      connects_required: 12,
      client_spent_usd: 50000,
      payment_verified: true,
    };
    expect(ProjectedGraphQLJobSchema.safeParse(sampleJob).success).toBe(true);
    expect(ProjectedGraphQLJobSchema.safeParse({ upwork_job_id: '' }).success).toBe(false);
    expect(
      ProjectedGraphQLJobSchema.safeParse({
        upwork_job_id: '~022115332344639171',
        contract_type: 'retainer',
      }).success,
    ).toBe(false);
    expect(
      ProjectedGraphQLJobSchema.safeParse({
        upwork_job_id: '~022115332344639171',
        proposals_count: -1,
      }).success,
    ).toBe(false);

    expect(
      SearchPaginationMetaSchema.safeParse({
        totalCount: 100,
        offset: 0,
        count: 20,
        page: 1,
        perPage: 20,
        hasNextPage: true,
        nextCursor: 'cursor-20',
      }).success,
    ).toBe(true);

    const validBatch = {
      captureSeq: 3,
      navigationEpoch: 2,
      captureKind: 'graphql' as const,
      requestUrl: 'https://www.upwork.com/api/graphql/v1',
      pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=golang',
      operationName: 'userJobSearchV1',
      sourceFeed: 'search' as const,
      query: 'golang',
      jobs: [sampleJob],
      paging: {
        totalCount: 40,
        offset: 0,
        count: 20,
        page: 1,
        perPage: 20,
        hasNextPage: true,
      },
      isExplicitEmpty: false,
      rawBytes: 900_000,
      chunkIndex: 0,
      chunkCount: 2,
      capturedAt: '2026-11-22T23:00:00.000Z',
    };
    expect(PassiveSearchBatchSchema.safeParse(validBatch).success).toBe(true);
    expect(
      PassiveSearchBatchSchema.safeParse({ ...validBatch, sourceFeed: 'unknown_feed' }).success,
    ).toBe(false);
    expect(
      PassiveSearchBatchSchema.safeParse({ ...validBatch, captureKind: 'websocket' }).success,
    ).toBe(false);
    expect(PassiveSearchBatchSchema.safeParse({ ...validBatch, chunkCount: 0 }).success).toBe(
      false,
    );

    expect(
      BackgroundCommandMessageSchema.safeParse({
        type: 'PASSIVE_SEARCH_BATCH',
        batch: validBatch,
      }).success,
    ).toBe(true);
    expect(
      BackgroundCommandMessageSchema.safeParse({
        type: 'PASSIVE_SEARCH_BATCH',
        batch: { ...validBatch, jobs: [{ upwork_job_id: '' }] },
      }).success,
    ).toBe(false);
  });

  it('validates snake_case WsSearchObservedNotificationSchema and ContentGuardCheckRequestSchema.waitForSearchApi', () => {
    const parsedWs = WsSearchObservedNotificationSchema.safeParse({
      jsonrpc: '2.0',
      method: 'search.observed',
      params: {
        tab_id: 42,
        page_url: 'https://www.upwork.com/nx/search/jobs/?q=golang',
        source_feed: 'search',
        query: 'golang',
        operation_name: 'userJobSearchV1',
        capture_kind: 'graphql',
        paging: {
          total_count: 45,
          offset: 20,
          count: 20,
          page: 2,
          per_page: 20,
          has_next_page: true,
          next_cursor: 'cur-2',
        },
        jobs: [
          {
            upwork_job_id: '~022115332344639171',
            job_title: 'Go Engineer',
            source: 'chrome_live_stream',
            source_feed: 'search',
            source_query: 'golang',
            url: 'https://www.upwork.com/jobs/~022115332344639171/',
            job_url: 'https://www.upwork.com/jobs/~022115332344639171/',
            canonical_url: 'https://www.upwork.com/jobs/~022115332344639171/',
            status: 'ready',
          },
        ],
        captured_at: '2026-11-22T23:00:00.000Z',
      },
    });
    expect(parsedWs.success).toBe(true);
    if (parsedWs.success) {
      expect(parsedWs.data.params.jobs[0]).toMatchObject({
        source: 'chrome_live_stream',
        source_feed: 'search',
        source_query: 'golang',
        job_url: 'https://www.upwork.com/jobs/~022115332344639171/',
        status: 'ready',
      });
    }

    expect(
      WsSearchObservedNotificationSchema.safeParse({
        jsonrpc: '2.0',
        method: 'wrong.method',
        params: { page_url: 'https://www.upwork.com/', source_feed: 'search', jobs: [] },
      }).success,
    ).toBe(false);
    expect(
      WsSearchObservedNotificationSchema.safeParse({
        jsonrpc: '2.0',
        method: 'search.observed',
        params: { pageUrl: 'https://www.upwork.com/', source_feed: 'search', jobs: [] },
      }).success,
    ).toBe(false);
    expect(
      WsSearchObservedNotificationSchema.safeParse({
        jsonrpc: '2.0',
        method: 'search.observed',
        params: { page_url: 'https://www.upwork.com/', source_feed: 'search' },
      }).success,
    ).toBe(false);

    expect(
      ContentGuardCheckRequestSchema.safeParse({
        type: 'CONTENT_CHECK_GUARDS',
      }).success,
    ).toBe(true);
    expect(
      ContentGuardCheckRequestSchema.safeParse({
        type: 'CONTENT_CHECK_GUARDS',
        waitForSearchApi: true,
      }).success,
    ).toBe(true);
    expect(
      ContentGuardCheckRequestSchema.safeParse({
        type: 'CONTENT_CHECK_GUARDS',
        waitForSearchApi: 'yes',
      }).success,
    ).toBe(false);
  });
});
