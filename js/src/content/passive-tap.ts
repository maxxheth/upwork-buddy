import {
  PASSIVE_TAP_EVENT,
  PASSIVE_TAP_READY_EVENT,
  type PassiveTapPayload,
} from '../shared/passive-tap-types';

const MAX_PAYLOAD_BYTES = 512 * 1024; // 512 KB cap per passive event
const MAX_BUFFERED_PAYLOADS = 25;

interface TapWindow extends Window {
  __upworkBuddyPassiveTapInstalled?: boolean;
  XMLHttpRequest?: typeof XMLHttpRequest;
}

export function isInterestingUpworkApiUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }
  const lower = rawUrl.toLowerCase();
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.css') ||
    lower.endsWith('.png') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.woff2') ||
    lower.includes('analytics') ||
    lower.includes('telemetry')
  ) {
    return false;
  }

  return (
    lower.includes('/api/graphql') ||
    lower.includes('/graphql') ||
    lower.includes('/api/v') ||
    lower.includes('/ab/messages/') ||
    lower.includes('/nx/')
  );
}

function resolveRequestUrl(input: RequestInfo | URL, baseHref: string): string {
  try {
    if (typeof input === 'string') {
      return new URL(input, baseHref).toString();
    }
    if (input instanceof URL) {
      return input.toString();
    }
    if (input && typeof input === 'object' && 'url' in input) {
      return new URL(input.url, baseHref).toString();
    }
  } catch {
    // ignore URL parse failure
  }
  return '';
}

function extractOperationName(url: string, body: unknown): string | undefined {
  if (typeof body === 'string' && body.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as { operationName?: unknown; alias?: unknown };
      if (typeof parsed.operationName === 'string' && parsed.operationName.trim()) {
        return parsed.operationName.trim();
      }
      if (typeof parsed.alias === 'string' && parsed.alias.trim()) {
        return parsed.alias.trim();
      }
    } catch {
      // ignore non-JSON body
    }
  }
  try {
    const parsedUrl = new URL(url);
    const alias = parsedUrl.searchParams.get('alias');
    if (alias) return alias;
    const parts = parsedUrl.pathname.split('/').filter(Boolean);
    return parts.at(-1);
  } catch {
    return undefined;
  }
}

function emitPayload(
  win: Window,
  payload: PassiveTapPayload,
  bufferedPayloads: PassiveTapPayload[],
  onEmit?: (payload: PassiveTapPayload) => void,
): void {
  try {
    const serialized = JSON.stringify(payload);
    if (serialized.length > MAX_PAYLOAD_BYTES) {
      return;
    }
    bufferedPayloads.push(payload);
    if (bufferedPayloads.length > MAX_BUFFERED_PAYLOADS) {
      bufferedPayloads.shift();
    }
    onEmit?.(payload);
    win.dispatchEvent(
      new CustomEvent<PassiveTapPayload>(PASSIVE_TAP_EVENT, {
        detail: payload,
      }),
    );
  } catch {
    // Never disrupt page execution
  }
}

export function installPassiveTap(
  win: Window,
  onEmit?: (payload: PassiveTapPayload) => void,
): boolean {
  const tapWin = win as TapWindow;
  if (tapWin.__upworkBuddyPassiveTapInstalled) {
    return false;
  }
  tapWin.__upworkBuddyPassiveTapInstalled = true;

  const bufferedPayloads: PassiveTapPayload[] = [];
  if (typeof win.addEventListener === 'function') {
    win.addEventListener(PASSIVE_TAP_READY_EVENT, () => {
      for (const buffered of bufferedPayloads) {
        try {
          win.dispatchEvent(
            new CustomEvent<PassiveTapPayload>(PASSIVE_TAP_EVENT, {
              detail: buffered,
            }),
          );
        } catch {
          // Never disrupt page execution
        }
      }
    });
  }

  const baseHref = win.location?.href || 'https://www.upwork.com/';

  if (typeof win.fetch === 'function') {
    const origFetch = win.fetch.bind(win);
    win.fetch = async function wrappedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const response = await origFetch(input, init);
      void (async () => {
        try {
          const url = resolveRequestUrl(input, win.location?.href || baseHref);
          if (!isInterestingUpworkApiUrl(url) || !response.ok) {
            return;
          }
          const contentType = response.headers?.get('content-type') ?? '';
          if (!contentType.toLowerCase().includes('json')) {
            return;
          }
          const cloned = response.clone();
          const data = (await cloned.json()) as unknown;
          const body =
            init?.body ??
            (typeof input === 'object' && input !== null && 'body' in input
              ? (input as Request).body
              : undefined);
          emitPayload(
            win,
            {
              kind: 'graphql',
              url,
              operationName: extractOperationName(url, body),
              data,
              capturedAt: new Date().toISOString(),
            },
            bufferedPayloads,
            onEmit,
          );
        } catch {
          // Read-only tap must never throw into page
        }
      })();
      return response;
    } as typeof win.fetch;
  }

  if (typeof tapWin.XMLHttpRequest === 'function') {
    const xhrProto = tapWin.XMLHttpRequest.prototype;
    const origOpen = xhrProto.open;
    const origSend = xhrProto.send;
    const metaMap = new WeakMap<XMLHttpRequest, { method: string; url: string }>();

    xhrProto.open = function wrappedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ): void {
      try {
        const resolved = resolveRequestUrl(
          typeof url === 'string' ? url : url.toString(),
          win.location?.href || baseHref,
        );
        metaMap.set(this, { method, url: resolved });
      } catch {
        // ignore
      }
      (origOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
    };

    xhrProto.send = function wrappedSend(
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      const meta = metaMap.get(this);
      if (meta && isInterestingUpworkApiUrl(meta.url)) {
        this.addEventListener(
          'load',
          () => {
            try {
              if (this.status < 200 || this.status >= 300) {
                return;
              }
              let data: unknown = null;
              if (this.responseType === 'json') {
                data = this.response;
              } else if (this.responseType === '' || this.responseType === 'text') {
                if (typeof this.responseText !== 'string' || !this.responseText.trim()) {
                  return;
                }
                data = JSON.parse(this.responseText);
              } else {
                return;
              }
              emitPayload(
                win,
                {
                  kind: 'xhr',
                  url: meta.url,
                  operationName: extractOperationName(meta.url, body),
                  data,
                  capturedAt: new Date().toISOString(),
                },
                bufferedPayloads,
                onEmit,
              );
            } catch {
              // Ignore non-JSON responses
            }
          },
          { once: true },
        );
      }
      origSend.call(this, body);
    };
  }

  return true;
}
