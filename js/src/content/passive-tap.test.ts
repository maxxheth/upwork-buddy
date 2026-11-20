import { describe, expect, it, vi } from 'vitest';
import {
  PASSIVE_TAP_EVENT,
  PASSIVE_TAP_READY_EVENT,
  type PassiveTapPayload,
} from '../shared/protocol';
import { installPassiveTap, isInterestingUpworkApiUrl } from './passive-tap';

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
});
