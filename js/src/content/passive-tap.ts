import {
  chunkSearchBatch,
  extractSearchProjection,
  extractSearchRequestContext,
  inferSourceFeed,
  type SearchRequestContextItem,
} from '../shared/graphql-search-parser';
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
  type ProjectedGraphQLJob,
  type SearchPaginationMeta,
} from '../shared/passive-tap-types';

const MAX_PAYLOAD_BYTES = 512 * 1024; // 512 KB cap per passive event
const MAX_BUFFERED_PAYLOADS = 25;
const MAX_RAW_JSON_BYTES = 16 * 1024 * 1024; // 16 MiB safety ceiling before JSON.parse
const MAX_PROJECTED_BATCH_BYTES = 450 * 1024;
const MAX_BUFFERED_SEARCH_BATCHES = 10;

const STATIC_ASSET_EXTENSIONS = ['.js', '.css', '.png', '.svg', '.woff2', '.ico', '.map'] as const;
const INTERESTING_API_PATHS = [
  '/api/graphql',
  '/graphql',
  '/api/v',
  '/ab/messages/',
  '/ab/jobs/',
  '/search/jobs/',
  '/nx/',
] as const;

interface TapWindow extends Window {
  __upworkBuddyPassiveTapInstalled?: boolean;
  XMLHttpRequest?: typeof XMLHttpRequest;
}

function utf8ByteLength(str: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).byteLength;
  }
  if (typeof Blob !== 'undefined') {
    return new Blob([str]).size;
  }
  let bytes = 0;
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

export function isInterestingUpworkApiUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return false;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed, 'https://www.upwork.com');
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (host !== 'upwork.com' && !host.endsWith('.upwork.com')) {
    return false;
  }
  if (
    host.startsWith('analytics.') ||
    host.startsWith('telemetry.') ||
    host.includes('.analytics.') ||
    host.includes('.telemetry.')
  ) {
    return false;
  }

  const pathLower = parsed.pathname.toLowerCase();
  if (STATIC_ASSET_EXTENSIONS.some((ext) => pathLower.endsWith(ext))) {
    return false;
  }

  if (pathLower.includes('analytics') || pathLower.includes('telemetry')) {
    return false;
  }

  return INTERESTING_API_PATHS.some((prefix) => pathLower.includes(prefix));
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
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        for (const entry of entries) {
          if (entry && typeof entry === 'object') {
            const rec = entry as { operationName?: unknown; alias?: unknown };
            if (typeof rec.operationName === 'string' && rec.operationName.trim()) {
              return rec.operationName.trim();
            }
            if (typeof rec.alias === 'string' && rec.alias.trim()) {
              return rec.alias.trim();
            }
          }
        }
      } catch {
        // ignore non-JSON body
      }
    }
  }
  try {
    const parsedUrl = new URL(url);
    const alias =
      parsedUrl.searchParams.get('alias') || parsedUrl.searchParams.get('operationName');
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
): 'emitted' | 'oversized' | 'error' {
  try {
    const serialized = JSON.stringify(payload);
    if (utf8ByteLength(serialized) > MAX_PAYLOAD_BYTES) {
      return 'oversized';
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
    return 'emitted';
  } catch {
    // Never disrupt page execution
    return 'error';
  }
}

function buildBoundedTruncatedSummary(params: {
  kind: 'graphql' | 'xhr';
  url: string;
  operationName?: string;
  data: unknown;
  capturedAt: string;
  originalBytes: number;
  jobs: ProjectedGraphQLJob[];
  paging?: SearchPaginationMeta;
  graphqlErrorCodes: string[];
}): PassiveTapPayload {
  const {
    kind,
    url,
    operationName,
    data,
    capturedAt,
    originalBytes,
    jobs,
    paging,
    graphqlErrorCodes,
  } = params;

  const topKeys =
    data && typeof data === 'object' && !Array.isArray(data)
      ? Object.keys(data as Record<string, unknown>).slice(0, 50)
      : Array.isArray(data)
        ? ['__array']
        : [];

  const safeOriginalBytes = Math.max(0, Math.trunc(originalBytes));

  const makeCandidate = (
    candidateJobs: ProjectedGraphQLJob[] | undefined,
    jobCount?: number,
    keys: string[] = topKeys,
  ): PassiveTapPayload => ({
    kind,
    url,
    ...(operationName ? { operationName } : {}),
    data: {
      __projected: true,
      topKeys: keys,
      ...(candidateJobs ? { jobs: candidateJobs } : {}),
      ...(jobCount !== undefined ? { jobCount } : {}),
      ...(paging ? { paging } : {}),
      ...(graphqlErrorCodes.length > 0 ? { graphqlErrorCodes } : {}),
    },
    capturedAt,
    truncated: true,
    originalBytes: safeOriginalBytes,
  });

  const fits = (candidate: PassiveTapPayload): boolean =>
    utf8ByteLength(JSON.stringify(candidate)) <= MAX_PAYLOAD_BYTES;

  if (jobs.length > 0) {
    const full = makeCandidate(jobs);
    if (fits(full)) {
      return full;
    }

    const shortDescJobs = jobs.map((job) =>
      job.job_description && job.job_description.length > 256
        ? { ...job, job_description: job.job_description.slice(0, 256) }
        : job,
    );
    const shortDescCandidate = makeCandidate(shortDescJobs);
    if (fits(shortDescCandidate)) {
      return shortDescCandidate;
    }

    const noDescJobs = jobs.map((job) => {
      if (job.job_description === undefined) return job;
      const copy = { ...job };
      delete copy.job_description;
      return copy;
    });
    const noDescCandidate = makeCandidate(noDescJobs);
    if (fits(noDescCandidate)) {
      return noDescCandidate;
    }

    let lo = 1;
    let hi = noDescJobs.length;
    let bestCount = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(makeCandidate(noDescJobs.slice(0, mid), jobs.length))) {
        bestCount = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (bestCount > 0) {
      return makeCandidate(noDescJobs.slice(0, bestCount), jobs.length);
    }
  }

  const minimal = makeCandidate(undefined, jobs.length > 0 ? jobs.length : undefined);
  if (fits(minimal)) {
    return minimal;
  }

  return makeCandidate(undefined, jobs.length > 0 ? jobs.length : undefined, []);
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
  const bufferedSearchBatches: PassiveSearchBatch[] = [];
  const baseHref = win.location?.href || 'https://www.upwork.com/';

  let navigationEpoch = 1;
  let captureSeq = 0;
  let inFlightSearchRequests = 0;
  let lastHref = baseHref;
  let lastObservedLocationHref = baseHref;

  const getCurrentHref = (): string => {
    const locHref =
      typeof win.location?.href === 'string' && win.location.href.trim()
        ? win.location.href
        : undefined;
    if (locHref && locHref !== lastObservedLocationHref) {
      handlePossibleNavigation();
    }
    return lastHref;
  };

  const emitSearchStatus = (): void => {
    try {
      win.dispatchEvent(
        new CustomEvent<PassiveSearchStatusDetail>(PASSIVE_SEARCH_STATUS_EVENT, {
          detail: {
            inFlightCount: inFlightSearchRequests,
            navigationEpoch,
          },
        }),
      );
    } catch {
      // Never disrupt page execution
    }
  };

  const handlePossibleNavigation = (nextArg?: unknown): void => {
    try {
      const locHref =
        typeof win.location?.href === 'string' && win.location.href.trim()
          ? win.location.href
          : undefined;
      let nextHref: string | undefined;
      if (locHref && locHref !== lastObservedLocationHref) {
        lastObservedLocationHref = locHref;
        nextHref = locHref;
      } else if (nextArg !== undefined && nextArg !== null) {
        const argStr = String(nextArg).trim();
        if (argStr.length > 0) {
          try {
            nextHref = new URL(argStr, lastHref).toString();
          } catch {
            // ignore invalid URL arg
          }
        }
      }

      if (!nextHref || nextHref === lastHref) {
        return;
      }

      lastHref = nextHref;
      navigationEpoch += 1;

      let pathname = '/';
      let search = '';
      try {
        const parsed = new URL(nextHref, baseHref);
        pathname = parsed.pathname;
        search = parsed.search;
      } catch {
        // ignore URL parse fallback
      }

      win.dispatchEvent(
        new CustomEvent<PassiveSpaNavDetail>(PASSIVE_SPA_NAV_EVENT, {
          detail: {
            url: nextHref,
            pathname,
            search,
            navigationEpoch,
            ts: new Date().toISOString(),
          },
        }),
      );
    } catch {
      // Never disrupt page execution
    }
  };

  const emitSearchBatchChunk = (chunk: PassiveSearchBatch): void => {
    try {
      bufferedSearchBatches.push(chunk);
      if (bufferedSearchBatches.length > MAX_BUFFERED_SEARCH_BATCHES) {
        bufferedSearchBatches.shift();
      }
      win.dispatchEvent(
        new CustomEvent<PassiveSearchBatch>(PASSIVE_SEARCH_BATCH_EVENT, {
          detail: chunk,
        }),
      );
    } catch {
      // Never disrupt page execution
    }
  };

  const handleCapturedResponse = (params: {
    kind: 'graphql' | 'xhr';
    url: string;
    pageUrl: string;
    navigationEpoch: number;
    data: unknown;
    rawBytes: number;
    bodyText?: string;
  }): void => {
    const { kind, url, pageUrl, navigationEpoch: reqEpoch, data, rawBytes, bodyText } = params;
    const capturedAt = new Date().toISOString();
    const reqCtx = extractSearchRequestContext(url, bodyText, pageUrl);
    const trimmedBody = typeof bodyText === 'string' ? bodyText.trim() : '';

    const isApolloBatch =
      Array.isArray(data) &&
      (reqCtx.items.length > 1 ||
        trimmedBody.startsWith('[') ||
        data.some(
          (el) =>
            typeof el === 'object' &&
            el !== null &&
            !Array.isArray(el) &&
            ('data' in el || 'errors' in el),
        ));

    const fallbackItem: SearchRequestContextItem = {
      ...(reqCtx.operationName ? { operationName: reqCtx.operationName } : {}),
      ...(reqCtx.query ? { query: reqCtx.query } : {}),
      ...(reqCtx.requestedPaging ? { requestedPaging: reqCtx.requestedPaging } : {}),
    };

    const entries: Array<{ itemData: unknown; itemCtx: SearchRequestContextItem }> = isApolloBatch
      ? (data as unknown[]).map((itemData, idx) => ({
          itemData,
          itemCtx: reqCtx.items[idx] ?? fallbackItem,
        }))
      : [{ itemData: data, itemCtx: reqCtx.items[0] ?? fallbackItem }];

    // Track 1: Project search batches BEFORE the legacy 512 KB cap
    const collectedJobs: ProjectedGraphQLJob[] = [];
    const seenJobIds = new Set<string>();
    let summaryPaging: SearchPaginationMeta | undefined;
    const collectedErrors = new Set<string>();

    for (const { itemData, itemCtx } of entries) {
      const projection = extractSearchProjection(itemData, {
        requestUrl: url,
        pageUrl,
        operationName: itemCtx.operationName,
        query: itemCtx.query,
        requestedPaging: itemCtx.requestedPaging,
      });

      for (const errCode of projection.graphqlErrorCodes) {
        collectedErrors.add(errCode);
      }
      if (projection.paging && !summaryPaging) {
        summaryPaging = projection.paging;
      }
      for (const job of projection.jobs) {
        if (!seenJobIds.has(job.upwork_job_id)) {
          seenJobIds.add(job.upwork_job_id);
          collectedJobs.push(job);
        }
      }

      if (
        projection.matched &&
        (projection.jobs.length > 0 ||
          projection.isExplicitEmpty ||
          projection.graphqlErrorCodes.length > 0)
      ) {
        captureSeq += 1;
        const batch: PassiveSearchBatch = {
          captureSeq,
          navigationEpoch: reqEpoch,
          captureKind: kind,
          requestUrl: url,
          pageUrl,
          ...(itemCtx.operationName ? { operationName: itemCtx.operationName } : {}),
          sourceFeed: inferSourceFeed(itemCtx.operationName, pageUrl),
          ...(itemCtx.query ? { query: itemCtx.query } : {}),
          jobs: projection.jobs,
          ...(projection.paging ? { paging: projection.paging } : {}),
          ...(projection.isExplicitEmpty ? { isExplicitEmpty: true } : {}),
          ...(projection.graphqlErrorCodes.length > 0
            ? { graphqlErrorCodes: projection.graphqlErrorCodes }
            : {}),
          rawBytes: Math.max(0, Math.trunc(rawBytes)),
          capturedAt,
        };

        const chunks = chunkSearchBatch(batch, MAX_PROJECTED_BATCH_BYTES);
        for (const chunk of chunks) {
          emitSearchBatchChunk(chunk);
        }
      }
    }

    // Track 2: Legacy PASSIVE_TAP_EVENT (<= 512 KB verbatim, or bounded > 512 KB summary)
    const operationName = reqCtx.operationName ?? extractOperationName(url, bodyText);
    const legacyPayload: PassiveTapPayload = {
      kind,
      url,
      ...(operationName ? { operationName } : {}),
      data,
      capturedAt,
    };

    const emitResult = emitPayload(win, legacyPayload, bufferedPayloads, onEmit);
    if (emitResult === 'oversized') {
      const summary = buildBoundedTruncatedSummary({
        kind,
        url,
        operationName,
        data,
        capturedAt,
        originalBytes: rawBytes,
        jobs: collectedJobs,
        paging: summaryPaging,
        graphqlErrorCodes: Array.from(collectedErrors),
      });
      emitPayload(win, summary, bufferedPayloads, onEmit);
    }
  };

  try {
    const hist = win.history;
    if (hist && typeof hist.pushState === 'function') {
      const origPushState = hist.pushState;
      hist.pushState = function wrappedPushState(
        this: History,
        data: unknown,
        unused: string,
        url?: string | URL | null,
      ): void {
        origPushState.call(this, data, unused, url);
        handlePossibleNavigation(url);
      };
    }
    if (hist && typeof hist.replaceState === 'function') {
      const origReplaceState = hist.replaceState;
      hist.replaceState = function wrappedReplaceState(
        this: History,
        data: unknown,
        unused: string,
        url?: string | URL | null,
      ): void {
        origReplaceState.call(this, data, unused, url);
        handlePossibleNavigation(url);
      };
    }
  } catch {
    // Ignore read-only history objects
  }

  try {
    if (typeof win.addEventListener === 'function') {
      win.addEventListener('popstate', () => {
        handlePossibleNavigation();
      });

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
        for (const batch of bufferedSearchBatches) {
          try {
            win.dispatchEvent(
              new CustomEvent<PassiveSearchBatch>(PASSIVE_SEARCH_BATCH_EVENT, {
                detail: batch,
              }),
            );
          } catch {
            // Never disrupt page execution
          }
        }
        emitSearchStatus();
      });
    }
  } catch {
    // Never disrupt page execution on minimal window mocks
  }

  if (typeof win.fetch === 'function') {
    const origFetch = win.fetch.bind(win);
    win.fetch = async function wrappedFetch(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const reqPageUrl = getCurrentHref();
      const reqEpoch = navigationEpoch;
      const url = resolveRequestUrl(input, reqPageUrl);
      const interesting = isInterestingUpworkApiUrl(url);

      let syncBodyText: string | undefined;
      if (typeof init?.body === 'string') {
        syncBodyText = init.body;
      }

      let reqClone: Request | undefined;
      if (interesting && syncBodyText === undefined && input && typeof input === 'object') {
        const maybeReq = input as Partial<Request>;
        const method =
          typeof init?.method === 'string'
            ? init.method.toUpperCase()
            : typeof maybeReq.method === 'string'
              ? maybeReq.method.toUpperCase()
              : '';
        if (typeof maybeReq.clone === 'function' && method !== 'GET' && method !== 'HEAD') {
          try {
            reqClone = maybeReq.clone();
          } catch {
            // Request may already be consumed (bodyUsed === true)
          }
        }
      }

      let trackedInFlight = false;
      const startInFlight = (): void => {
        if (trackedInFlight) return;
        trackedInFlight = true;
        const prev = inFlightSearchRequests;
        inFlightSearchRequests += 1;
        if (prev === 0) {
          emitSearchStatus();
        }
      };
      const finishInFlight = (): void => {
        if (!trackedInFlight) return;
        trackedInFlight = false;
        if (inFlightSearchRequests > 0) {
          inFlightSearchRequests -= 1;
        }
        if (inFlightSearchRequests === 0) {
          emitSearchStatus();
        }
      };

      if (interesting) {
        const syncCtx = extractSearchRequestContext(url, syncBodyText, reqPageUrl);
        if (syncCtx.isSearchRequest) {
          startInFlight();
        }
      }

      let response: Response;
      try {
        response = await origFetch(input, init);
      } catch (err) {
        finishInFlight();
        throw err;
      }

      let cloned: Response | undefined;
      if (interesting && response.ok) {
        const contentType = response.headers?.get?.('content-type') ?? '';
        if (contentType.toLowerCase().includes('json')) {
          const contentLengthRaw = response.headers?.get?.('content-length');
          let oversizedHeader = false;
          if (typeof contentLengthRaw === 'string' && contentLengthRaw.trim().length > 0) {
            const parsedLen = Number(contentLengthRaw.trim());
            if (Number.isFinite(parsedLen) && parsedLen > MAX_RAW_JSON_BYTES) {
              oversizedHeader = true;
            }
          }
          if (!oversizedHeader) {
            try {
              cloned = response.clone();
            } catch {
              // Ignore Response clone failures (e.g. body already used or clone unavailable)
            }
          }
        }
      }

      if (!cloned) {
        finishInFlight();
        return response;
      }

      void (async () => {
        try {
          let bodyText = syncBodyText;
          if (bodyText === undefined && reqClone) {
            try {
              bodyText = await reqClone.text();
            } catch {
              // Ignore Request body read failures
            }
          }

          if (!trackedInFlight) {
            const asyncCtx = extractSearchRequestContext(url, bodyText, reqPageUrl);
            if (asyncCtx.isSearchRequest) {
              startInFlight();
            }
          }

          let data: unknown;
          let rawBytes: number;
          if (typeof cloned.text === 'function') {
            const rawText = await cloned.text();
            rawBytes = utf8ByteLength(rawText);
            if (rawBytes > MAX_RAW_JSON_BYTES || !rawText.trim()) {
              return;
            }
            data = JSON.parse(rawText) as unknown;
          } else {
            data = (await cloned.json()) as unknown;
            const serialized = JSON.stringify(data);
            if (typeof serialized !== 'string') {
              return;
            }
            rawBytes = utf8ByteLength(serialized);
            if (rawBytes > MAX_RAW_JSON_BYTES) {
              return;
            }
          }

          handleCapturedResponse({
            kind: 'graphql',
            url,
            pageUrl: reqPageUrl,
            navigationEpoch: reqEpoch,
            data,
            rawBytes,
            bodyText,
          });
        } catch {
          // Read-only tap must never throw into page
        } finally {
          finishInFlight();
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
      metaMap.delete(this);
      try {
        const resolved = resolveRequestUrl(
          typeof url === 'string' ? url : url.toString(),
          getCurrentHref(),
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
        const reqPageUrl = getCurrentHref();
        const reqEpoch = navigationEpoch;
        const bodyText = typeof body === 'string' ? body : undefined;
        const syncCtx = extractSearchRequestContext(meta.url, bodyText, reqPageUrl);

        let trackedInFlight = false;
        if (syncCtx.isSearchRequest) {
          trackedInFlight = true;
          const prev = inFlightSearchRequests;
          inFlightSearchRequests += 1;
          if (prev === 0) {
            emitSearchStatus();
          }
        }

        let settled = false;

        const finishInFlight = (): void => {
          if (!trackedInFlight) return;
          trackedInFlight = false;
          if (inFlightSearchRequests > 0) {
            inFlightSearchRequests -= 1;
          }
          if (inFlightSearchRequests === 0) {
            emitSearchStatus();
          }
        };

        const cleanupListeners = (): void => {
          if (typeof this.removeEventListener === 'function') {
            this.removeEventListener('load', onLoad);
            this.removeEventListener('error', onTerminal);
            this.removeEventListener('abort', onTerminal);
            this.removeEventListener('timeout', onTerminal);
            this.removeEventListener('loadend', onTerminal);
          }
        };

        const onTerminal = (): void => {
          settled = true;
          cleanupListeners();
          finishInFlight();
        };

        const onLoad = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          cleanupListeners();
          try {
            if (this.status < 200 || this.status >= 300) {
              return;
            }
            if (typeof this.getResponseHeader === 'function') {
              const contentType = this.getResponseHeader('content-type');
              if (
                typeof contentType === 'string' &&
                contentType.trim().length > 0 &&
                !contentType.toLowerCase().includes('json')
              ) {
                return;
              }
              const contentLengthRaw = this.getResponseHeader('content-length');
              if (typeof contentLengthRaw === 'string' && contentLengthRaw.trim().length > 0) {
                const parsedLen = Number(contentLengthRaw.trim());
                if (Number.isFinite(parsedLen) && parsedLen > MAX_RAW_JSON_BYTES) {
                  return;
                }
              }
            }

            let data: unknown = null;
            let rawBytes = 0;
            if (this.responseType === 'json') {
              data = this.response;
              if (data === null || data === undefined) {
                return;
              }
              const serialized = JSON.stringify(data);
              if (typeof serialized !== 'string') {
                return;
              }
              rawBytes = utf8ByteLength(serialized);
              if (rawBytes > MAX_RAW_JSON_BYTES) {
                return;
              }
            } else if (this.responseType === '' || this.responseType === 'text') {
              if (typeof this.responseText !== 'string' || !this.responseText.trim()) {
                return;
              }
              rawBytes = utf8ByteLength(this.responseText);
              if (rawBytes > MAX_RAW_JSON_BYTES) {
                return;
              }
              data = JSON.parse(this.responseText) as unknown;
            } else {
              return;
            }

            handleCapturedResponse({
              kind: 'xhr',
              url: meta.url,
              pageUrl: reqPageUrl,
              navigationEpoch: reqEpoch,
              data,
              rawBytes,
              bodyText,
            });
          } catch {
            // Ignore non-JSON responses
          } finally {
            finishInFlight();
          }
        };

        this.addEventListener('load', onLoad, { once: true });
        this.addEventListener('error', onTerminal, { once: true });
        this.addEventListener('abort', onTerminal, { once: true });
        this.addEventListener('timeout', onTerminal, { once: true });
        this.addEventListener('loadend', onTerminal, { once: true });

        try {
          origSend.call(this, body);
        } catch (err) {
          settled = true;
          cleanupListeners();
          finishInFlight();
          throw err;
        }
        return;
      }
      origSend.call(this, body);
    };
  }

  return true;
}
