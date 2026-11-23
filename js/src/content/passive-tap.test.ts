import { describe, expect, it, vi } from 'vitest';
import {
  PASSIVE_SEARCH_BATCH_EVENT,
  PASSIVE_SEARCH_STATUS_EVENT,
  PASSIVE_SPA_NAV_EVENT,
  PASSIVE_TAP_EVENT,
  PASSIVE_TAP_READY_EVENT,
  type PassiveSearchBatch,
  type PassiveSearchStatusDetail,
  type PassiveSpaNavDetail,
  type PassiveTapPayload,
} from '../shared/protocol';
import { installPassiveTap, isInterestingUpworkApiUrl } from './passive-tap';

function makeJobNode(idx: number, descriptionPadding = ''): Record<string, unknown> {
  const idHex = String(idx).padStart(16, '0');
  return {
    ciphertext: `~01${idHex}`,
    title: `Senior Engineer #${idx}`,
    description: `Build distributed systems ${idx} ${descriptionPadding}`.trim(),
    publishedOn: '2026-11-22T12:00:00Z',
    jobType: 'HOURLY',
    hourlyBudgetMin: { amount: 60 },
    hourlyBudgetMax: { amount: 95 },
    contractorTier: 3,
    proposalsTier: '5_9',
    connectPrice: 12,
    ontologySkills: [{ prettyName: 'Go' }, { prettyName: 'TypeScript' }],
    client: {
      totalSpent: { amount: 25000 },
      paymentVerificationStatus: 'VERIFIED',
      totalFeedback: 4.95,
      totalReviews: 18,
      location: { country: 'United States' },
    },
  };
}

function makeUserJobSearchResponse(
  jobs: Array<Record<string, unknown>>,
  paging: { total: number; offset: number; count: number },
): Record<string, unknown> {
  return {
    data: {
      search: {
        universalSearchNuxt: {
          userJobSearchV1: {
            results: jobs.map((job) => ({ jobTile: { job } })),
            paging,
          },
        },
      },
    },
  };
}

describe('Passive GraphQL / XHR Tap (MAIN world helper)', () => {
  it('filters interesting Upwork API URLs vs static/analytics assets', () => {
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/api/graphql/jobs')).toBe(true);
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/nx/search/jobs/?q=go')).toBe(true);
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/ab/messages/rooms')).toBe(true);
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/static/app.js')).toBe(false);
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/analytics/collect')).toBe(false);
  });

  it('observes fetch GraphQL responses read-only, passes through rejections, and enforces idempotency', async () => {
    const events: PassiveTapPayload[] = [];
    const fakeWin = {
      location: { href: 'https://www.upwork.com/nx/search/jobs/' },
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('fail-me')) {
          throw new Error('Upstream network failure');
        }
        return new Response(JSON.stringify({ data: { jobs: [1, 2] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
      dispatchEvent: vi.fn((evt: CustomEvent<PassiveTapPayload>) => {
        if (evt.type === PASSIVE_TAP_EVENT) {
          events.push(evt.detail);
        }
        return true;
      }),
    } as unknown as Window;

    expect(installPassiveTap(fakeWin)).toBe(true);
    // Second call must be a no-op
    expect(installPassiveTap(fakeWin)).toBe(false);

    const res = await fakeWin.fetch('https://www.upwork.com/api/graphql/jobs-search', {
      method: 'POST',
      body: JSON.stringify({ operationName: 'JobSearch' }),
    });
    expect(res.ok).toBe(true);

    // Wait for detached microtask
    await new Promise((r) => setTimeout(r, 10));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('graphql');
    expect(events[0]?.operationName).toBe('JobSearch');

    // Rejection passes through untouched
    await expect(fakeWin.fetch('https://www.upwork.com/api/graphql/fail-me')).rejects.toThrow(
      'Upstream network failure',
    );
  });

  it('observes XMLHttpRequest JSON responses read-only', async () => {
    const events: PassiveTapPayload[] = [];

    class FakeXHR {
      status = 200;
      responseType = '';
      responseText = '{"threads":[{"id":"room-1"}]}';
      response = null;
      private listeners = new Map<string, Array<() => void>>();

      open(_method: string, _url: string): void {}
      send(_body?: unknown): void {
        for (const cb of this.listeners.get('load') ?? []) {
          cb();
        }
      }
      addEventListener(type: string, cb: () => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(cb);
        this.listeners.set(type, list);
      }
    }

    const fakeWin = {
      location: { href: 'https://www.upwork.com/ab/messages/rooms' },
      XMLHttpRequest: FakeXHR,
      dispatchEvent: vi.fn((evt: CustomEvent<PassiveTapPayload>) => {
        if (evt.type === PASSIVE_TAP_EVENT) {
          events.push(evt.detail);
        }
        return true;
      }),
    } as unknown as Window;

    installPassiveTap(fakeWin);
    const xhr = new FakeXHR();
    xhr.open('GET', '/ab/messages/rooms');
    xhr.send();

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('xhr');
    expect(events[0]?.url).toContain('/ab/messages/rooms');
  });

  it('buffers payloads emitted before listener mounts and replays them on PASSIVE_TAP_READY_EVENT (capped at 25)', async () => {
    const target = new EventTarget();
    let seq = 0;
    const fakeWin = {
      location: { href: 'https://www.upwork.com/nx/search/jobs/' },
      fetch: vi.fn(async () => {
        seq += 1;
        return new Response(JSON.stringify({ data: { seq } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
      dispatchEvent: (evt: Event) => target.dispatchEvent(evt),
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        target.addEventListener(type, cb),
    } as unknown as Window;

    expect(installPassiveTap(fakeWin)).toBe(true);

    // Emit 27 payloads before any ISOLATED listener subscribes
    for (let i = 0; i < 27; i += 1) {
      await fakeWin.fetch(`https://www.upwork.com/api/graphql/search?i=${i}`);
    }
    await new Promise((r) => setTimeout(r, 20));

    const replayed: PassiveTapPayload[] = [];
    target.addEventListener(PASSIVE_TAP_EVENT, (evt) => {
      replayed.push((evt as CustomEvent<PassiveTapPayload>).detail);
    });
    target.dispatchEvent(new CustomEvent(PASSIVE_TAP_READY_EVENT));

    expect(replayed).toHaveLength(25);
    expect((replayed[0]?.data as { data?: { seq?: number } })?.data?.seq).toBe(3);
    expect((replayed[24]?.data as { data?: { seq?: number } })?.data?.seq).toBe(27);
  });

  it('enforces expanded URL host, path, and static suffix rules', () => {
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/ab/jobs/search')).toBe(true);
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/search/jobs/?q=rust')).toBe(true);
    expect(isInterestingUpworkApiUrl('/api/graphql/jobs')).toBe(true);
    expect(isInterestingUpworkApiUrl('https://sub.upwork.com/api/graphql')).toBe(true);
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/nx/search/jobs/?q=node.js')).toBe(
      true,
    );

    expect(isInterestingUpworkApiUrl('https://evil.com/api/graphql')).toBe(false);
    expect(isInterestingUpworkApiUrl('https://evilupwork.com/api/graphql')).toBe(false);
    expect(isInterestingUpworkApiUrl('javascript:alert(1)')).toBe(false);
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/favicon.ico')).toBe(false);
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/app.js.map')).toBe(false);
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/static/app.js?v=1')).toBe(false);
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/telemetry/ping')).toBe(false);
  });

  it('captures >512 KB (~1.2 MB) GraphQL search payload as PASSIVE_SEARCH_BATCH_EVENT and truncated summary', async () => {
    const target = new EventTarget();
    const batches: PassiveSearchBatch[] = [];
    const taps: PassiveTapPayload[] = [];
    target.addEventListener(PASSIVE_SEARCH_BATCH_EVENT, (evt) => {
      batches.push((evt as CustomEvent<PassiveSearchBatch>).detail);
    });
    target.addEventListener(PASSIVE_TAP_EVENT, (evt) => {
      taps.push((evt as CustomEvent<PassiveTapPayload>).detail);
    });

    const padding = 'x'.repeat(23_000);
    const fiftyJobs = Array.from({ length: 50 }, (_, i) => makeJobNode(i + 1, padding));
    const bigPayload = makeUserJobSearchResponse(fiftyJobs, { total: 120, offset: 0, count: 50 });
    const rawJson = JSON.stringify(bigPayload);
    expect(Buffer.byteLength(rawJson, 'utf8')).toBeGreaterThan(1_100_000);

    const fakeWin = {
      location: { href: 'https://www.upwork.com/nx/search/jobs/?q=golang' },
      fetch: vi.fn(
        async () =>
          new Response(rawJson, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
      dispatchEvent: (evt: Event) => target.dispatchEvent(evt),
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        target.addEventListener(type, cb),
    } as unknown as Window;

    installPassiveTap(fakeWin);
    await fakeWin.fetch('https://www.upwork.com/api/graphql?alias=userJobSearchV1', {
      method: 'POST',
      body: JSON.stringify({
        operationName: 'userJobSearchV1',
        variables: { requestVariables: { userQuery: 'golang', paging: { offset: 0, count: 50 } } },
      }),
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(batches.length).toBeGreaterThanOrEqual(1);
    const allJobs = batches.flatMap((b) => b.jobs);
    expect(allJobs).toHaveLength(50);
    expect(batches[0]?.sourceFeed).toBe('search');
    expect(batches[0]?.query).toBe('golang');
    expect(batches[0]?.paging?.totalCount).toBe(120);
    expect(batches[0]?.paging?.hasNextPage).toBe(true);
    expect(batches[0]?.rawBytes).toBeGreaterThan(512 * 1024);
    for (const chunk of batches) {
      expect(Buffer.byteLength(JSON.stringify(chunk), 'utf8')).toBeLessThanOrEqual(450 * 1024);
    }

    expect(taps).toHaveLength(1);
    expect(taps[0]?.truncated).toBe(true);
    expect(taps[0]?.originalBytes).toBe(Buffer.byteLength(rawJson, 'utf8'));
    expect((taps[0]?.data as { __projected?: boolean })?.__projected).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(taps[0]), 'utf8')).toBeLessThanOrEqual(512 * 1024);
  });

  it('bounds >512 KB truncated PASSIVE_TAP_EVENT summary even when projection jobs exceed 512 KB with multibyte UTF-8', async () => {
    const target = new EventTarget();
    const batches: PassiveSearchBatch[] = [];
    const taps: PassiveTapPayload[] = [];
    target.addEventListener(PASSIVE_SEARCH_BATCH_EVENT, (evt) => {
      batches.push((evt as CustomEvent<PassiveSearchBatch>).detail);
    });
    target.addEventListener(PASSIVE_TAP_EVENT, (evt) => {
      taps.push((evt as CustomEvent<PassiveTapPayload>).detail);
    });

    const unicodePadding = '🚀'.repeat(4_000); // 16 KB UTF-8 per job
    const jobs = Array.from({ length: 40 }, (_, i) => makeJobNode(i + 1, unicodePadding));
    const bigPayload = makeUserJobSearchResponse(jobs, { total: 40, offset: 0, count: 40 });
    const rawJson = JSON.stringify(bigPayload);

    const fakeWin = {
      location: { href: 'https://www.upwork.com/nx/search/jobs/?q=unicode' },
      fetch: vi.fn(
        async () =>
          new Response(rawJson, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
      dispatchEvent: (evt: Event) => target.dispatchEvent(evt),
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        target.addEventListener(type, cb),
    } as unknown as Window;

    installPassiveTap(fakeWin);
    await fakeWin.fetch('https://www.upwork.com/api/graphql?alias=userJobSearchV1', {
      method: 'POST',
      body: JSON.stringify({ operationName: 'userJobSearchV1' }),
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((b) => b.jobs)).toHaveLength(40);
    for (const chunk of batches) {
      expect(Buffer.byteLength(JSON.stringify(chunk), 'utf8')).toBeLessThanOrEqual(450 * 1024);
    }

    expect(taps).toHaveLength(1);
    expect(taps[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(taps[0]), 'utf8')).toBeLessThanOrEqual(512 * 1024);
  });

  it('rejects responses exceeding 16 MiB Content-Length or raw body ceiling without throwing', async () => {
    const target = new EventTarget();
    const batches: PassiveSearchBatch[] = [];
    const taps: PassiveTapPayload[] = [];
    const statuses: PassiveSearchStatusDetail[] = [];
    target.addEventListener(PASSIVE_SEARCH_BATCH_EVENT, (evt) => {
      batches.push((evt as CustomEvent<PassiveSearchBatch>).detail);
    });
    target.addEventListener(PASSIVE_TAP_EVENT, (evt) => {
      taps.push((evt as CustomEvent<PassiveTapPayload>).detail);
    });
    target.addEventListener(PASSIVE_SEARCH_STATUS_EVENT, (evt) => {
      statuses.push((evt as CustomEvent<PassiveSearchStatusDetail>).detail);
    });

    const fakeWin = {
      location: { href: 'https://www.upwork.com/nx/search/jobs/?q=huge' },
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('header-huge')) {
          return new Response(JSON.stringify({ data: { ok: true } }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': String(17 * 1024 * 1024),
            },
          });
        }
        const giant = JSON.stringify({ data: { blob: 'a'.repeat(16 * 1024 * 1024 + 100) } });
        return new Response(giant, {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
      dispatchEvent: (evt: Event) => target.dispatchEvent(evt),
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        target.addEventListener(type, cb),
    } as unknown as Window;

    installPassiveTap(fakeWin);

    const res1 = await fakeWin.fetch('https://www.upwork.com/api/graphql/header-huge', {
      method: 'POST',
      body: JSON.stringify({ operationName: 'userJobSearchV1' }),
    });
    const res2 = await fakeWin.fetch('https://www.upwork.com/api/graphql/body-huge', {
      method: 'POST',
      body: JSON.stringify({ operationName: 'userJobSearchV1' }),
    });
    expect(res1.ok).toBe(true);
    expect(res2.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 20));
    expect(batches).toHaveLength(0);
    expect(taps).toHaveLength(0);
    expect(statuses.at(-1)?.inFlightCount).toBe(0);
  });

  it('keeps 10-slot search buffer immune to 30 noisy calls and replays both buffers plus status on PASSIVE_TAP_READY_EVENT', async () => {
    const target = new EventTarget();
    let noisySeq = 0;

    const fakeWin = {
      location: { href: 'https://www.upwork.com/nx/search/jobs/' },
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        if (body.includes('userJobSearchV1')) {
          const parsed = JSON.parse(body) as { variables?: { seq?: number } };
          const seq = parsed.variables?.seq ?? 0;
          return new Response(
            JSON.stringify(
              makeUserJobSearchResponse([makeJobNode(seq)], {
                total: 100,
                offset: (seq - 1) * 10,
                count: 10,
              }),
            ),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        noisySeq += 1;
        return new Response(JSON.stringify({ data: { featureFlags: { n: noisySeq } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
      dispatchEvent: (evt: Event) => target.dispatchEvent(evt),
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        target.addEventListener(type, cb),
    } as unknown as Window;

    installPassiveTap(fakeWin);

    for (let i = 1; i <= 12; i += 1) {
      await fakeWin.fetch('https://www.upwork.com/api/graphql?alias=userJobSearchV1', {
        method: 'POST',
        body: JSON.stringify({ operationName: 'userJobSearchV1', variables: { seq: i } }),
      });
    }
    for (let i = 1; i <= 30; i += 1) {
      await fakeWin.fetch('https://www.upwork.com/api/graphql?alias=featureFlags', {
        method: 'POST',
        body: JSON.stringify({ operationName: 'featureFlags' }),
      });
    }
    await new Promise((r) => setTimeout(r, 30));

    const replayedBatches: PassiveSearchBatch[] = [];
    const replayedTaps: PassiveTapPayload[] = [];
    const replayedStatuses: PassiveSearchStatusDetail[] = [];

    target.addEventListener(PASSIVE_SEARCH_BATCH_EVENT, (evt) => {
      replayedBatches.push((evt as CustomEvent<PassiveSearchBatch>).detail);
    });
    target.addEventListener(PASSIVE_TAP_EVENT, (evt) => {
      replayedTaps.push((evt as CustomEvent<PassiveTapPayload>).detail);
    });
    target.addEventListener(PASSIVE_SEARCH_STATUS_EVENT, (evt) => {
      replayedStatuses.push((evt as CustomEvent<PassiveSearchStatusDetail>).detail);
    });

    target.dispatchEvent(new CustomEvent(PASSIVE_TAP_READY_EVENT));

    expect(replayedBatches).toHaveLength(10);
    expect(replayedBatches[0]?.jobs[0]?.upwork_job_id).toBe('~010000000000000003');
    expect(replayedBatches[9]?.jobs[0]?.upwork_job_id).toBe('~010000000000000012');
    expect(replayedTaps).toHaveLength(25);
    expect(replayedStatuses.at(-1)).toEqual({ inFlightCount: 0, navigationEpoch: 1 });
  });

  it('captures fetch(Request) POST body, correlates Apollo batched arrays, and tolerates pre-consumed Request', async () => {
    const target = new EventTarget();
    const batches: PassiveSearchBatch[] = [];
    target.addEventListener(PASSIVE_SEARCH_BATCH_EVENT, (evt) => {
      batches.push((evt as CustomEvent<PassiveSearchBatch>).detail);
    });

    const fakeWin = {
      location: { href: 'https://www.upwork.com/nx/find-work/best-matches' },
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const reqText = input instanceof Request && !input.bodyUsed ? await input.text() : '';
        if (reqText.trim().startsWith('[')) {
          return new Response(
            JSON.stringify([
              { data: { featureFlags: { darkMode: true } } },
              makeUserJobSearchResponse([makeJobNode(77)], {
                total: 100,
                offset: 20,
                count: 20,
              }),
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            data: {
              bestMatchJobsFeed: {
                results: [makeJobNode(55)],
                paging: { total: 40, offset: 0, count: 20 },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
      dispatchEvent: (evt: Event) => target.dispatchEvent(evt),
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        target.addEventListener(type, cb),
    } as unknown as Window;

    installPassiveTap(fakeWin);

    // 1. fetch(new Request(...)) single POST
    const singleReq = new Request('https://www.upwork.com/api/graphql/v1', {
      method: 'POST',
      body: JSON.stringify({
        operationName: 'bestMatchJobsFeed',
        variables: { requestVariables: { userQuery: 'typescript' } },
      }),
    });
    await fakeWin.fetch(singleReq);

    // 2. Apollo batched array
    const batchReq = new Request('https://www.upwork.com/api/graphql/v1', {
      method: 'POST',
      body: JSON.stringify([
        { operationName: 'featureFlags', variables: {} },
        {
          operationName: 'userJobSearchV1',
          variables: { requestVariables: { userQuery: 'rust', paging: { offset: 20, count: 20 } } },
        },
      ]),
    });
    await fakeWin.fetch(batchReq);

    // 3. Pre-consumed Request (bodyUsed === true) must not throw
    const consumedReq = new Request('https://www.upwork.com/api/graphql/v1', {
      method: 'POST',
      body: JSON.stringify({ operationName: 'bestMatchJobsFeed' }),
    });
    await consumedReq.text();
    const res3 = await fakeWin.fetch(consumedReq);
    expect(res3.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 20));

    expect(batches).toHaveLength(3);
    expect(batches[0]?.operationName).toBe('bestMatchJobsFeed');
    expect(batches[0]?.sourceFeed).toBe('best_matches');
    expect(batches[0]?.query).toBe('typescript');

    expect(batches[1]?.operationName).toBe('userJobSearchV1');
    expect(batches[1]?.query).toBe('rust');
    expect(batches[1]?.paging?.page).toBe(2);
    expect(batches[1]?.paging?.hasNextPage).toBe(true);
  });

  it('tracks SPA history navigationEpoch, attributes in-flight responses to initiation epoch, and cleans up errors', async () => {
    const target = new EventTarget();
    const batches: PassiveSearchBatch[] = [];
    const navEvents: PassiveSpaNavDetail[] = [];
    const statusEvents: PassiveSearchStatusDetail[] = [];

    target.addEventListener(PASSIVE_SEARCH_BATCH_EVENT, (evt) => {
      batches.push((evt as CustomEvent<PassiveSearchBatch>).detail);
    });
    target.addEventListener(PASSIVE_SPA_NAV_EVENT, (evt) => {
      navEvents.push((evt as CustomEvent<PassiveSpaNavDetail>).detail);
    });
    target.addEventListener(PASSIVE_SEARCH_STATUS_EVENT, (evt) => {
      statusEvents.push((evt as CustomEvent<PassiveSearchStatusDetail>).detail);
    });

    let resolveDeferred!: (res: Response) => void;
    const locObj = { href: 'https://www.upwork.com/nx/search/jobs/?q=go' };

    const historyObj = {
      pushState(_data: unknown, _unused: string, url?: string | URL | null) {
        if (url !== undefined && url !== null && String(url).trim() !== '') {
          locObj.href = new URL(String(url), locObj.href).toString();
        }
      },
      replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
        if (url !== undefined && url !== null && String(url).trim() !== '') {
          locObj.href = new URL(String(url), locObj.href).toString();
        }
      },
    };

    class ErrorXHR {
      status = 0;
      responseType = '';
      responseText = '';
      response = null;
      private listeners = new Map<string, Array<() => void>>();
      open(_method: string, _url: string): void {}
      send(_body?: unknown): void {
        for (const cb of this.listeners.get('error') ?? []) {
          cb();
        }
      }
      addEventListener(type: string, cb: () => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(cb);
        this.listeners.set(type, list);
      }
    }

    const fakeWin = {
      location: locObj,
      history: historyObj,
      XMLHttpRequest: ErrorXHR,
      fetch: vi.fn((input: RequestInfo | URL) => {
        if (String(input).includes('deferred')) {
          return new Promise<Response>((resolve) => {
            resolveDeferred = resolve;
          });
        }
        return Promise.reject(new Error('Network down'));
      }),
      dispatchEvent: (evt: Event) => target.dispatchEvent(evt),
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        target.addEventListener(type, cb),
    } as unknown as Window;

    installPassiveTap(fakeWin);

    // Start deferred search in epoch 1
    const deferredPromise = fakeWin.fetch('https://www.upwork.com/api/graphql/deferred', {
      method: 'POST',
      body: JSON.stringify({
        operationName: 'userJobSearchV1',
        variables: { requestVariables: { userQuery: 'go' } },
      }),
    });

    expect(statusEvents.at(-1)).toEqual({ inFlightCount: 1, navigationEpoch: 1 });

    // Navigate via pushState -> epoch 2
    historyObj.pushState({}, '', '/nx/search/jobs/?q=rust');
    expect(navEvents).toHaveLength(1);
    expect(navEvents[0]).toMatchObject({
      pathname: '/nx/search/jobs/',
      search: '?q=rust',
      navigationEpoch: 2,
    });

    // Same-URL and empty-URL pushState must NOT bump navigationEpoch
    historyObj.pushState({}, '', '/nx/search/jobs/?q=rust');
    historyObj.pushState({}, '', undefined);
    expect(navEvents).toHaveLength(1);

    // replaceState -> epoch 3
    historyObj.replaceState({}, '', '/nx/search/jobs/?q=python');
    expect(navEvents).toHaveLength(2);
    expect(navEvents[1]?.navigationEpoch).toBe(3);

    // Resolve epoch 1 fetch while currently in epoch 3
    resolveDeferred(
      new Response(
        JSON.stringify(
          makeUserJobSearchResponse([makeJobNode(88)], { total: 1, offset: 0, count: 10 }),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await deferredPromise;
    await new Promise((r) => setTimeout(r, 20));

    expect(batches).toHaveLength(1);
    expect(batches[0]?.navigationEpoch).toBe(1);
    expect(batches[0]?.pageUrl).toBe('https://www.upwork.com/nx/search/jobs/?q=go');
    expect(statusEvents.at(-1)).toEqual({ inFlightCount: 0, navigationEpoch: 3 });

    // popstate -> epoch 4
    locObj.href = 'https://www.upwork.com/nx/search/jobs/?q=go';
    target.dispatchEvent(new Event('popstate'));
    expect(navEvents).toHaveLength(3);
    expect(navEvents[2]?.navigationEpoch).toBe(4);

    // Rejected fetch + XHR error must clean up inFlightCount back to 0
    await expect(
      fakeWin.fetch('https://www.upwork.com/api/graphql/reject', {
        method: 'POST',
        body: JSON.stringify({ operationName: 'userJobSearchV1' }),
      }),
    ).rejects.toThrow('Network down');
    expect(statusEvents.at(-1)?.inFlightCount).toBe(0);

    const xhr = new ErrorXHR();
    xhr.open('POST', '/api/graphql?alias=userJobSearchV1');
    xhr.send(JSON.stringify({ operationName: 'userJobSearchV1' }));
    expect(statusEvents.at(-1)?.inFlightCount).toBe(0);
  });

  it('supports XHR responseType=json without reading responseText, isExplicitEmpty, and graphqlErrorCodes', async () => {
    const target = new EventTarget();
    const batches: PassiveSearchBatch[] = [];
    target.addEventListener(PASSIVE_SEARCH_BATCH_EVENT, (evt) => {
      batches.push((evt as CustomEvent<PassiveSearchBatch>).detail);
    });

    class JsonXHR {
      status = 200;
      responseType = 'json';
      response: unknown = null;
      private listeners = new Map<string, Array<() => void>>();

      get responseText(): string {
        throw new Error('InvalidStateError: responseText unreadable when responseType is json');
      }
      open(_method: string, _url: string): void {}
      send(_body?: unknown): void {
        for (const cb of this.listeners.get('load') ?? []) {
          cb();
        }
      }
      addEventListener(type: string, cb: () => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(cb);
        this.listeners.set(type, list);
      }
    }

    const fakeWin = {
      location: { href: 'https://www.upwork.com/nx/search/jobs/?q=elixir' },
      XMLHttpRequest: JsonXHR,
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('empty')) {
          return new Response(
            JSON.stringify(makeUserJobSearchResponse([], { total: 0, offset: 0, count: 20 })),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            errors: [{ extensions: { code: 'UNAUTHENTICATED' }, message: 'Login required' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
      dispatchEvent: (evt: Event) => target.dispatchEvent(evt),
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        target.addEventListener(type, cb),
    } as unknown as Window;

    installPassiveTap(fakeWin);

    // 1. XHR responseType='json'
    const xhr = new JsonXHR();
    xhr.response = {
      data: {
        marketplaceJobPostingsSearch: {
          edges: [{ node: makeJobNode(99) }],
          totalCount: 50,
          pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
        },
      },
    };
    xhr.open('POST', '/api/graphql?alias=marketplaceJobPostingsSearch');
    xhr.send(JSON.stringify({ operationName: 'marketplaceJobPostingsSearch' }));

    // 2. isExplicitEmpty
    await fakeWin.fetch('https://www.upwork.com/api/graphql/empty', {
      method: 'POST',
      body: JSON.stringify({ operationName: 'userJobSearchV1' }),
    });

    // 3. graphqlErrorCodes
    await fakeWin.fetch('https://www.upwork.com/api/graphql/auth-err', {
      method: 'POST',
      body: JSON.stringify({ operationName: 'userJobSearchV1' }),
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(batches).toHaveLength(3);
    expect(batches[0]?.captureKind).toBe('xhr');
    expect(batches[0]?.paging?.nextCursor).toBe('cursor-2');
    expect(batches[0]?.jobs[0]?.upwork_job_id).toBe('~010000000000000099');

    expect(batches[1]?.isExplicitEmpty).toBe(true);
    expect(batches[1]?.jobs).toHaveLength(0);

    expect(batches[2]?.graphqlErrorCodes).toContain('UNAUTHENTICATED');
  });

  it('allows analytics/telemetry in search query strings while rejecting analytics/telemetry paths and subdomains', () => {
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/nx/search/jobs/?q=analytics')).toBe(
      true,
    );
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/search/jobs/?q=telemetry')).toBe(true);
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/api/graphql?q=google-analytics')).toBe(
      true,
    );

    expect(isInterestingUpworkApiUrl('https://www.upwork.com/analytics/collect')).toBe(false);
    expect(isInterestingUpworkApiUrl('https://www.upwork.com/telemetry/ping')).toBe(false);
    expect(isInterestingUpworkApiUrl('https://telemetry.upwork.com/api/v1/events')).toBe(false);
    expect(isInterestingUpworkApiUrl('https://analytics.upwork.com/api/graphql')).toBe(false);
    expect(isInterestingUpworkApiUrl('https://eu.telemetry.upwork.com/nx/collect')).toBe(false);
  });

  it('emits PASSIVE_SPA_NAV_EVENT and attributes consistently when location.href changes before fetch and popstate', async () => {
    const target = new EventTarget();
    const batches: PassiveSearchBatch[] = [];
    const navEvents: PassiveSpaNavDetail[] = [];
    const statusEvents: PassiveSearchStatusDetail[] = [];

    target.addEventListener(PASSIVE_SEARCH_BATCH_EVENT, (evt) => {
      batches.push((evt as CustomEvent<PassiveSearchBatch>).detail);
    });
    target.addEventListener(PASSIVE_SPA_NAV_EVENT, (evt) => {
      navEvents.push((evt as CustomEvent<PassiveSpaNavDetail>).detail);
    });
    target.addEventListener(PASSIVE_SEARCH_STATUS_EVENT, (evt) => {
      statusEvents.push((evt as CustomEvent<PassiveSearchStatusDetail>).detail);
    });

    const locObj = { href: 'https://www.upwork.com/nx/search/jobs/?q=initial' };
    let seq = 0;

    const fakeWin = {
      location: locObj,
      fetch: vi.fn(async () => {
        seq += 1;
        return new Response(
          JSON.stringify(
            makeUserJobSearchResponse([makeJobNode(200 + seq)], {
              total: 10,
              offset: 0,
              count: 10,
            }),
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
      dispatchEvent: (evt: Event) => target.dispatchEvent(evt),
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        target.addEventListener(type, cb),
    } as unknown as Window;

    installPassiveTap(fakeWin);

    // Mutate location.href before popstate fires (e.g. Back/Forward timing)
    locObj.href = 'https://www.upwork.com/nx/search/jobs/?q=back_button_target';

    await fakeWin.fetch('https://www.upwork.com/api/graphql?alias=userJobSearchV1', {
      method: 'POST',
      body: JSON.stringify({
        operationName: 'userJobSearchV1',
        variables: { requestVariables: { userQuery: 'back_button_target' } },
      }),
    });

    target.dispatchEvent(new Event('popstate'));

    await fakeWin.fetch('https://www.upwork.com/api/graphql?alias=userJobSearchV1', {
      method: 'POST',
      body: JSON.stringify({
        operationName: 'userJobSearchV1',
        variables: { requestVariables: { userQuery: 'back_button_target' } },
      }),
    });

    await new Promise((r) => setTimeout(r, 20));

    expect(navEvents).toHaveLength(1);
    expect(navEvents[0]).toMatchObject({
      url: 'https://www.upwork.com/nx/search/jobs/?q=back_button_target',
      search: '?q=back_button_target',
      navigationEpoch: 2,
    });
    expect(batches).toHaveLength(2);
    expect(batches[0]?.navigationEpoch).toBe(2);
    expect(batches[0]?.pageUrl).toBe('https://www.upwork.com/nx/search/jobs/?q=back_button_target');
    expect(batches[1]?.navigationEpoch).toBe(2);
    expect(batches[1]?.pageUrl).toBe('https://www.upwork.com/nx/search/jobs/?q=back_button_target');
    expect(statusEvents.at(-1)).toEqual({ inFlightCount: 0, navigationEpoch: 2 });
  });

  it('detaches and disables stale XHR listeners when origSend throws synchronously', () => {
    const target = new EventTarget();
    const batches: PassiveSearchBatch[] = [];
    const taps: PassiveTapPayload[] = [];
    const statuses: PassiveSearchStatusDetail[] = [];

    target.addEventListener(PASSIVE_SEARCH_BATCH_EVENT, (evt) => {
      batches.push((evt as CustomEvent<PassiveSearchBatch>).detail);
    });
    target.addEventListener(PASSIVE_TAP_EVENT, (evt) => {
      taps.push((evt as CustomEvent<PassiveTapPayload>).detail);
    });
    target.addEventListener(PASSIVE_SEARCH_STATUS_EVENT, (evt) => {
      statuses.push((evt as CustomEvent<PassiveSearchStatusDetail>).detail);
    });

    class ReusableThrowXHR {
      status = 200;
      responseType = '';
      responseText = JSON.stringify(
        makeUserJobSearchResponse([makeJobNode(301)], { total: 1, offset: 0, count: 10 }),
      );
      response = null;
      shouldThrowOnSend = false;
      private listeners = new Map<string, Array<() => void>>();

      open(_method: string, _url: string): void {}
      send(_body?: unknown): void {
        if (this.shouldThrowOnSend) {
          throw new Error('InvalidStateError');
        }
        for (const cb of [...(this.listeners.get('load') ?? [])]) {
          cb();
        }
        for (const cb of [...(this.listeners.get('loadend') ?? [])]) {
          cb();
        }
      }
      addEventListener(type: string, cb: () => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(cb);
        this.listeners.set(type, list);
      }
      removeEventListener(type: string, cb: () => void): void {
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(
          type,
          list.filter((fn) => fn !== cb),
        );
      }
      listenerCount(type: string): number {
        return (this.listeners.get(type) ?? []).length;
      }
    }

    const fakeWin = {
      location: { href: 'https://www.upwork.com/nx/search/jobs/?q=xhr' },
      XMLHttpRequest: ReusableThrowXHR,
      dispatchEvent: (evt: Event) => target.dispatchEvent(evt),
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        target.addEventListener(type, cb),
    } as unknown as Window;

    installPassiveTap(fakeWin);

    const xhr = new ReusableThrowXHR();
    xhr.shouldThrowOnSend = true;
    xhr.open('POST', 'https://www.upwork.com/api/graphql?alias=userJobSearchV1');
    expect(() => xhr.send(JSON.stringify({ operationName: 'userJobSearchV1' }))).toThrow(
      'InvalidStateError',
    );

    expect(statuses.at(-1)?.inFlightCount).toBe(0);
    expect(xhr.listenerCount('load')).toBe(0);
    expect(xhr.listenerCount('loadend')).toBe(0);

    // Reuse same XHR instance for an uninteresting URL; stale onLoad must NOT fire
    xhr.shouldThrowOnSend = false;
    xhr.open('GET', 'https://evil.com/api/graphql');
    xhr.send();

    expect(batches).toHaveLength(0);
    expect(taps).toHaveLength(0);
    expect(statuses.at(-1)?.inFlightCount).toBe(0);

    // Reuse same XHR instance for a valid request; should still capture cleanly
    xhr.open('POST', 'https://www.upwork.com/api/graphql?alias=userJobSearchV1');
    xhr.send(JSON.stringify({ operationName: 'userJobSearchV1' }));

    expect(batches).toHaveLength(1);
    expect(batches[0]?.jobs[0]?.upwork_job_id).toBe('~010000000000000301');
    expect(taps).toHaveLength(1);
    expect(statuses.at(-1)?.inFlightCount).toBe(0);

    // Even if an XHR mock lacks removeEventListener, the settled guard prevents stale onLoad on reuse
    (xhr as unknown as { removeEventListener?: unknown }).removeEventListener = undefined;
    xhr.shouldThrowOnSend = true;
    xhr.open('POST', 'https://www.upwork.com/api/graphql?alias=userJobSearchV1');
    expect(() => xhr.send(JSON.stringify({ operationName: 'userJobSearchV1' }))).toThrow(
      'InvalidStateError',
    );
    xhr.shouldThrowOnSend = false;
    xhr.open('GET', 'https://evil.com/api/graphql');
    xhr.send();
    expect(batches).toHaveLength(1);
    expect(taps).toHaveLength(1);
    expect(statuses.at(-1)?.inFlightCount).toBe(0);
  });

  it('clones fetch(Request) response synchronously so immediate caller response.json() consumption never drops capture', async () => {
    const target = new EventTarget();
    const batches: PassiveSearchBatch[] = [];
    const taps: PassiveTapPayload[] = [];
    target.addEventListener(PASSIVE_SEARCH_BATCH_EVENT, (evt) => {
      batches.push((evt as CustomEvent<PassiveSearchBatch>).detail);
    });
    target.addEventListener(PASSIVE_TAP_EVENT, (evt) => {
      taps.push((evt as CustomEvent<PassiveTapPayload>).detail);
    });

    const fakeWin = {
      location: { href: 'https://www.upwork.com/nx/search/jobs/?q=golang' },
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        if (input instanceof Request && !input.bodyUsed) {
          await input.text();
        }
        return new Response(
          JSON.stringify(
            makeUserJobSearchResponse([makeJobNode(404)], {
              total: 1,
              offset: 0,
              count: 1,
            }),
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
      dispatchEvent: (evt: Event) => target.dispatchEvent(evt),
      addEventListener: (type: string, cb: EventListenerOrEventListenerObject) =>
        target.addEventListener(type, cb),
    } as unknown as Window;

    installPassiveTap(fakeWin);

    const req = new Request('https://www.upwork.com/api/graphql/v1', {
      method: 'POST',
      body: JSON.stringify({
        operationName: 'userJobSearchV1',
        variables: { requestVariables: { userQuery: 'golang' } },
      }),
    });

    const res = await fakeWin.fetch(req);
    const callerBody = (await res.json()) as {
      data: { search: { universalSearchNuxt: { userJobSearchV1: { results: unknown[] } } } };
    };
    expect(res.bodyUsed).toBe(true);
    expect(callerBody.data.search.universalSearchNuxt.userJobSearchV1.results).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 30));

    expect(batches).toHaveLength(1);
    expect(batches[0]?.operationName).toBe('userJobSearchV1');
    expect(batches[0]?.query).toBe('golang');
    expect(batches[0]?.jobs).toHaveLength(1);
    expect(batches[0]?.jobs[0]?.upwork_job_id).toBe('~010000000000000404');

    expect(taps).toHaveLength(1);
    expect(taps[0]?.operationName).toBe('userJobSearchV1');
  });
});
