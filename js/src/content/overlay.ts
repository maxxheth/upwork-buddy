import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from 'wxt/utils/content-script-ui/shadow-root';
import { UpworkBuddy } from '../main';
import {
  type ContentAuditSelectorsRequest,
  type ContentCaptureUiDiagnosticRequest,
  type ContentGuardCheckRequest,
  type ContentMessagesDraftRequest,
  type ContentMessagesGetRequest,
  type ContentMessagesListRequest,
  type ContentMessagesSendRequest,
  type ContentProposalFillRequest,
  type ContentProposalSubmitRequest,
  type ContentProposalsSyncRequest,
  type ContentScrapeDetailRequest,
  type ContentScrapeSearchRequest,
  type ContentSelectorsReloadedMessage,
  type ContentTestSelectorPatchRequest,
  PASSIVE_SEARCH_BATCH_EVENT,
  PASSIVE_SEARCH_STATUS_EVENT,
  PASSIVE_SPA_NAV_EVENT,
  PASSIVE_TAP_EVENT,
  PASSIVE_TAP_READY_EVENT,
  type PassiveSearchBatch,
  type PassiveTapPayload,
  type ProjectedGraphQLJob,
  type RuntimeStatusSnapshot,
  type SearchFeedKind,
  type SearchPaginationMeta,
  type UpWorkPageBlueprint,
} from '../shared/protocol';
import { ProposalFillParamsSchema, ProposalSubmitParamsSchema } from '../shared/schemas';
import { BUNDLED_SELECTORS, loadActiveSelectors, type SelectorConfig } from '../shared/selectors';
import { extractJobDetail } from './adapters/detail-adapter';
import {
  buildPageBlueprint,
  computeOverallAuditStatus,
  DriftAuditor,
} from './adapters/drift-auditor';
import {
  extractMessageRooms,
  extractMessageThread,
  fillMessageComposer,
  sendMessageFromComposer,
} from './adapters/messages-adapter';
import {
  extractProposalsList,
  fillProposalForm,
  submitProposalForm,
} from './adapters/proposal-adapter';
import { extractSearchListings, resolveSearchViewName } from './adapters/search-adapter';
import { detectChallengeOrAuth, waitForHydration } from './guards';
import { captureUiDiagnostic, testSelectorPatchOnDocument } from './ui-capture';

export { detectChallengeOrAuth, waitForHydration };

const MAX_RECENT_SEARCH_BATCHES = 15;
const MAX_SEEN_BATCH_FINGERPRINTS = 100;
const MAX_TAP_EPOCH_KEYS = 50;
const MAX_SANITIZED_JOBS_PER_BATCH = 100;
const MAX_JOB_DESCRIPTION_CHARS = 16_384;
const SPA_DOM_FALLBACK_DELAY_MS = 1200;
const IN_FLIGHT_SETTLE_DELAY_MS = 75;
const VALID_JOB_ID_RE = /^~[0-9a-zA-Z]{1,64}$/;
const VALID_SOURCE_FEEDS = new Set<SearchFeedKind>([
  'search',
  'best_matches',
  'most_recent',
  'saved_jobs',
]);
const VALID_CAPTURE_KINDS = new Set<PassiveSearchBatch['captureKind']>([
  'graphql',
  'xhr',
  'spa_dom',
]);

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function normalizeTapCorrelationKey(url: string, capturedAt: string): string {
  let normalizedUrl: string;
  try {
    normalizedUrl = new URL(url).toString();
  } catch {
    normalizedUrl = url.trim();
  }
  return `${normalizedUrl}\0${capturedAt}`;
}

function sanitizeUpworkHttpsUrl(
  raw: unknown,
  allowSubdomains: boolean,
  maxLen = 4096,
): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    return null;
  }
  if (parsed.port !== '') {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (allowSubdomains) {
    if (host !== 'upwork.com' && !host.endsWith('.upwork.com')) {
      return null;
    }
  } else if (host !== 'www.upwork.com') {
    return null;
  }
  return parsed.toString();
}

function sanitizeCappedString(raw: unknown, maxLen: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLen) : undefined;
}

function sanitizeNonNegativeInt(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
}

function sanitizeNonNegativeFinite(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function sanitizeProjectedJob(raw: unknown): ProjectedGraphQLJob | null {
  if (!isPlainRecord(raw)) return null;
  const id = typeof raw.upwork_job_id === 'string' ? raw.upwork_job_id.trim() : '';
  if (!VALID_JOB_ID_RE.test(id)) return null;

  const job: ProjectedGraphQLJob = { upwork_job_id: id };

  const jobTitle = sanitizeCappedString(raw.job_title, 512);
  if (jobTitle !== undefined) job.job_title = jobTitle;

  const jobDesc = sanitizeCappedString(raw.job_description, MAX_JOB_DESCRIPTION_CHARS);
  if (jobDesc !== undefined) job.job_description = jobDesc;

  const canonicalUrl = sanitizeUpworkHttpsUrl(raw.canonical_url, false, 512);
  if (canonicalUrl !== null) job.canonical_url = canonicalUrl;

  const jobUrl = sanitizeUpworkHttpsUrl(raw.url, true, 512);
  if (jobUrl !== null) job.url = jobUrl;

  if (raw.contract_type === 'hourly' || raw.contract_type === 'fixed' || raw.contract_type === '') {
    job.contract_type = raw.contract_type;
  }

  const budget = sanitizeCappedString(raw.budget, 128);
  if (budget !== undefined) job.budget = budget;

  if (typeof raw.budget_amount === 'string') {
    const trimmedBudgetAmount = raw.budget_amount.trim().slice(0, 64);
    job.budget_amount = trimmedBudgetAmount;
  }

  const rateRange = sanitizeCappedString(raw.rate_range, 128);
  if (rateRange !== undefined) job.rate_range = rateRange;

  const rateMin = sanitizeCappedString(raw.rate_min, 64);
  if (rateMin !== undefined) job.rate_min = rateMin;

  const rateMax = sanitizeCappedString(raw.rate_max, 64);
  if (rateMax !== undefined) job.rate_max = rateMax;

  const expLevel = sanitizeCappedString(raw.experience_level, 64);
  if (expLevel !== undefined) job.experience_level = expLevel;

  const duration = sanitizeCappedString(raw.duration, 128);
  if (duration !== undefined) job.duration = duration;

  const hoursPerWeek = sanitizeCappedString(raw.hours_per_week, 128);
  if (hoursPerWeek !== undefined) job.hours_per_week = hoursPerWeek;

  const skills = sanitizeCappedString(raw.skills, 2048);
  if (skills !== undefined) job.skills = skills;

  const postedText = sanitizeCappedString(raw.posted_text, 128);
  if (postedText !== undefined) job.posted_text = postedText;

  const postedAtEst = sanitizeCappedString(raw.posted_at_est, 64);
  if (postedAtEst !== undefined) job.posted_at_est = postedAtEst;

  const proposalsTier = sanitizeCappedString(raw.proposals_tier, 64);
  if (proposalsTier !== undefined) job.proposals_tier = proposalsTier;

  const proposalsCount = sanitizeNonNegativeInt(raw.proposals_count);
  if (proposalsCount !== undefined) job.proposals_count = proposalsCount;

  const connectsRequired = sanitizeNonNegativeInt(raw.connects_required);
  if (connectsRequired !== undefined) job.connects_required = connectsRequired;

  const clientCountry = sanitizeCappedString(raw.client_country, 128);
  if (clientCountry !== undefined) job.client_country = clientCountry;

  const clientRating = sanitizeNonNegativeFinite(raw.client_rating);
  if (clientRating !== undefined) job.client_rating = clientRating;

  const clientReviews = sanitizeNonNegativeInt(raw.client_reviews);
  if (clientReviews !== undefined) job.client_reviews = clientReviews;

  const clientSpent = sanitizeCappedString(raw.client_spent, 64);
  if (clientSpent !== undefined) job.client_spent = clientSpent;

  const clientSpentUsd = sanitizeNonNegativeFinite(raw.client_spent_usd);
  if (clientSpentUsd !== undefined) job.client_spent_usd = clientSpentUsd;

  const clientHires = sanitizeNonNegativeInt(raw.client_hires);
  if (clientHires !== undefined) job.client_hires = clientHires;

  const clientHireRate = sanitizeNonNegativeFinite(raw.client_hire_rate);
  if (clientHireRate !== undefined) job.client_hire_rate = clientHireRate;

  if (typeof raw.payment_verified === 'boolean') {
    job.payment_verified = raw.payment_verified;
  }

  return job;
}

function sanitizeSearchPaging(raw: unknown): SearchPaginationMeta | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const paging: SearchPaginationMeta = {};

  const totalCount = sanitizeNonNegativeInt(raw.totalCount);
  if (totalCount !== undefined) paging.totalCount = totalCount;

  const offset = sanitizeNonNegativeInt(raw.offset);
  if (offset !== undefined) paging.offset = offset;

  const count = sanitizeNonNegativeInt(raw.count);
  if (count !== undefined) paging.count = count;

  const page = sanitizeNonNegativeInt(raw.page);
  if (page !== undefined) paging.page = page;

  const perPage = sanitizeNonNegativeInt(raw.perPage);
  if (perPage !== undefined) paging.perPage = perPage;

  if (typeof raw.hasNextPage === 'boolean') {
    paging.hasNextPage = raw.hasNextPage;
  }

  const nextCursor = sanitizeCappedString(raw.nextCursor, 512);
  if (nextCursor !== undefined) paging.nextCursor = nextCursor;

  return Object.keys(paging).length > 0 ? paging : undefined;
}

export function sanitizePassiveSearchBatch(raw: unknown): PassiveSearchBatch | null {
  if (!isPlainRecord(raw)) return null;

  const captureSeq = sanitizeNonNegativeInt(raw.captureSeq);
  if (captureSeq === undefined) return null;

  const navigationEpoch =
    typeof raw.navigationEpoch === 'number' &&
    Number.isSafeInteger(raw.navigationEpoch) &&
    raw.navigationEpoch >= 1
      ? raw.navigationEpoch
      : undefined;
  if (navigationEpoch === undefined) return null;

  if (
    typeof raw.captureKind !== 'string' ||
    !VALID_CAPTURE_KINDS.has(raw.captureKind as PassiveSearchBatch['captureKind'])
  ) {
    return null;
  }
  const captureKind = raw.captureKind as PassiveSearchBatch['captureKind'];

  const requestUrl = sanitizeUpworkHttpsUrl(raw.requestUrl, true);
  if (!requestUrl) return null;

  const pageUrl = sanitizeUpworkHttpsUrl(raw.pageUrl, false);
  if (!pageUrl) return null;

  if (
    typeof raw.sourceFeed !== 'string' ||
    !VALID_SOURCE_FEEDS.has(raw.sourceFeed as SearchFeedKind)
  ) {
    return null;
  }
  const sourceFeed = raw.sourceFeed as SearchFeedKind;

  const capturedAt = sanitizeCappedString(raw.capturedAt, 64);
  if (!capturedAt || Number.isNaN(Date.parse(capturedAt))) return null;

  if (!Array.isArray(raw.jobs)) return null;
  const jobs: ProjectedGraphQLJob[] = [];
  for (const item of raw.jobs.slice(0, MAX_SANITIZED_JOBS_PER_BATCH)) {
    const sanitizedJob = sanitizeProjectedJob(item);
    if (sanitizedJob) {
      jobs.push(sanitizedJob);
    }
  }

  const operationName = sanitizeCappedString(raw.operationName, 128);
  const query = sanitizeCappedString(raw.query, 512);
  const paging = sanitizeSearchPaging(raw.paging);
  const isExplicitEmpty =
    typeof raw.isExplicitEmpty === 'boolean' ? raw.isExplicitEmpty : undefined;

  let graphqlErrorCodes: string[] | undefined;
  if (Array.isArray(raw.graphqlErrorCodes)) {
    const cleaned = raw.graphqlErrorCodes
      .map((code) => sanitizeCappedString(code, 64))
      .filter((code): code is string => code !== undefined)
      .slice(0, 16);
    if (cleaned.length > 0) {
      graphqlErrorCodes = cleaned;
    }
  }

  const rawBytes = sanitizeNonNegativeInt(raw.rawBytes);
  const rawChunkIndex = sanitizeNonNegativeInt(raw.chunkIndex);
  const rawChunkCount =
    typeof raw.chunkCount === 'number' &&
    Number.isSafeInteger(raw.chunkCount) &&
    raw.chunkCount >= 1
      ? raw.chunkCount
      : undefined;
  const validChunks =
    rawChunkIndex !== undefined && rawChunkCount !== undefined
      ? rawChunkIndex < rawChunkCount
      : true;

  return {
    captureSeq,
    navigationEpoch,
    captureKind,
    requestUrl,
    pageUrl,
    ...(operationName !== undefined ? { operationName } : {}),
    sourceFeed,
    ...(query !== undefined ? { query } : {}),
    jobs,
    ...(paging !== undefined ? { paging } : {}),
    ...(isExplicitEmpty !== undefined ? { isExplicitEmpty } : {}),
    ...(graphqlErrorCodes !== undefined ? { graphqlErrorCodes } : {}),
    ...(rawBytes !== undefined ? { rawBytes } : {}),
    ...(validChunks && rawChunkIndex !== undefined ? { chunkIndex: rawChunkIndex } : {}),
    ...(validChunks && rawChunkCount !== undefined ? { chunkCount: rawChunkCount } : {}),
    capturedAt,
  };
}

function resolveSpaFeedFromPathname(pathname: string): SearchFeedKind | null {
  const normalized = pathname.toLowerCase().replace(/\/+$/, '') || '/';
  if (normalized === '/nx/search/jobs' || normalized === '/search/jobs') {
    return 'search';
  }
  if (normalized === '/nx/find-work/best-matches') {
    return 'best_matches';
  }
  if (normalized === '/nx/find-work/most-recent') {
    return 'most_recent';
  }
  if (normalized === '/nx/find-work/saved-jobs') {
    return 'saved_jobs';
  }
  return null;
}

function isVisibleDomElement(el: Element | null): boolean {
  if (!el) return false;
  if (el.hasAttribute('hidden')) return false;
  const style = (el as HTMLElement).style;
  if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
  return true;
}

async function resolveContentSelectors(explicit?: SelectorConfig): Promise<SelectorConfig> {
  if (explicit) {
    return explicit;
  }
  try {
    return await loadActiveSelectors();
  } catch {
    return BUNDLED_SELECTORS;
  }
}

export async function mountUpworkOverlay(
  ctx: ContentScriptContext,
): Promise<ShadowRootContentScriptUi<UpworkBuddy>> {
  let buddyInstance: UpworkBuddy | null = null;
  let activeAbortController: AbortController | null = null;
  const recentPassivePayloads: Array<{ payload: PassiveTapPayload; navigationEpoch: number }> = [];
  let currentNavigationEpoch = 1;
  let inFlightSearchCount = 0;
  let syntheticSpaSeq = 0;
  let invalidated = false;
  let spaFallbackTimer: ReturnType<typeof setTimeout> | null = null;
  const recentSearchBatches: PassiveSearchBatch[] = [];
  const seenBatchFingerprints = new Set<string>();
  const tapEpochByRequestKey = new Map<string, number>();
  const searchBatchListeners = new Set<() => void>();

  const notifySearchListeners = () => {
    for (const listener of [...searchBatchListeners]) {
      try {
        listener();
      } catch {
        // ignore subscriber errors
      }
    }
  };

  const clearSpaFallbackTimer = () => {
    if (spaFallbackTimer !== null) {
      clearTimeout(spaFallbackTimer);
      spaFallbackTimer = null;
    }
  };

  const getMatchingSearchBatches = (
    opts: { capturedSince?: string; pageUrl?: string; expectedPage?: number } = {},
  ): PassiveSearchBatch[] => {
    const sinceMs = opts.capturedSince ? Date.parse(opts.capturedSince) : Number.NaN;
    const targetPage = opts.pageUrl ? sanitizeUpworkHttpsUrl(opts.pageUrl, false) : null;
    const stripHash = (u: string): string => {
      const idx = u.indexOf('#');
      return idx === -1 ? u : u.slice(0, idx);
    };
    const targetPageNoHash = targetPage ? stripHash(targetPage) : null;

    const filtered = recentSearchBatches.filter((batch) => {
      if (batch.navigationEpoch !== currentNavigationEpoch) {
        return false;
      }
      if (targetPageNoHash && stripHash(batch.pageUrl) !== targetPageNoHash) {
        return false;
      }
      if (
        opts.expectedPage !== undefined &&
        batch.paging?.page !== undefined &&
        batch.paging.page !== opts.expectedPage
      ) {
        return false;
      }
      if (Number.isFinite(sinceMs)) {
        const batchMs = Date.parse(batch.capturedAt);
        if (Number.isFinite(batchMs) && batchMs < sinceMs) {
          return false;
        }
      }
      return true;
    });

    return [...filtered].sort(
      (a, b) => a.captureSeq - b.captureSeq || (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0),
    );
  };

  const getMatchingPassivePayloads = (
    opts: { capturedSince?: string } = {},
  ): PassiveTapPayload[] => {
    const sinceMs = opts.capturedSince ? Date.parse(opts.capturedSince) : Number.NaN;
    return recentPassivePayloads
      .filter((entry) => {
        if (entry.navigationEpoch !== currentNavigationEpoch) {
          return false;
        }
        if (Number.isFinite(sinceMs)) {
          const payloadMs = Date.parse(entry.payload.capturedAt);
          if (Number.isFinite(payloadMs) && payloadMs < sinceMs) {
            return false;
          }
        }
        return true;
      })
      .map((entry) => entry.payload);
  };

  const recordAndMaybeForwardBatch = (batch: PassiveSearchBatch) => {
    const fingerprint = JSON.stringify([
      batch.navigationEpoch,
      batch.captureKind,
      batch.operationName ?? '',
      batch.query ?? '',
      batch.paging?.offset ?? null,
      batch.paging?.nextCursor ?? '',
      batch.isExplicitEmpty ? 1 : 0,
      batch.chunkIndex ?? 0,
      batch.jobs.map((j) => j.upwork_job_id),
    ]);
    if (seenBatchFingerprints.has(fingerprint)) {
      return;
    }
    if (seenBatchFingerprints.size >= MAX_SEEN_BATCH_FINGERPRINTS) {
      const oldest = seenBatchFingerprints.values().next().value;
      if (oldest !== undefined) {
        seenBatchFingerprints.delete(oldest);
      }
    }
    seenBatchFingerprints.add(fingerprint);

    recentSearchBatches.unshift(batch);
    if (recentSearchBatches.length > MAX_RECENT_SEARCH_BATCHES) {
      recentSearchBatches.length = MAX_RECENT_SEARCH_BATCHES;
    }

    if (batch.navigationEpoch > currentNavigationEpoch) {
      currentNavigationEpoch = batch.navigationEpoch;
      clearSpaFallbackTimer();
    } else if (
      batch.navigationEpoch === currentNavigationEpoch &&
      batch.captureKind !== 'spa_dom'
    ) {
      clearSpaFallbackTimer();
    }

    notifySearchListeners();

    const probe = detectChallengeOrAuth(document, window.location);
    if (!probe.challengeDetected && probe.loggedIn && batch.jobs.length > 0) {
      void browser.runtime
        .sendMessage({
          type: 'PASSIVE_SEARCH_BATCH',
          batch,
        })
        .catch(() => undefined);
    }
  };

  const runSpaDomFallback = async (
    scheduledEpoch: number,
    scheduledFeed: SearchFeedKind,
    scheduledNavUrl: string,
  ) => {
    spaFallbackTimer = null;
    if (invalidated || scheduledEpoch !== currentNavigationEpoch || inFlightSearchCount > 0) {
      return;
    }
    const hasGraphqlBefore = recentSearchBatches.some(
      (b) => b.navigationEpoch === scheduledEpoch && b.captureKind !== 'spa_dom',
    );
    if (hasGraphqlBefore) {
      return;
    }

    const selectors = await resolveContentSelectors();
    if (invalidated || scheduledEpoch !== currentNavigationEpoch || inFlightSearchCount > 0) {
      return;
    }
    const hasGraphqlAfter = recentSearchBatches.some(
      (b) => b.navigationEpoch === scheduledEpoch && b.captureKind !== 'spa_dom',
    );
    if (hasGraphqlAfter) {
      return;
    }

    const effectiveUrl =
      window.location.origin === 'https://www.upwork.com' ? window.location.href : scheduledNavUrl;
    const effectiveLoc =
      window.location.origin === 'https://www.upwork.com' ? window.location : new URL(effectiveUrl);
    const query = new URL(effectiveUrl).searchParams.get('q')?.trim() || undefined;

    const extracted = extractSearchListings(document, {
      source: scheduledFeed,
      query,
      selectors,
      passivePayloads: getMatchingPassivePayloads({}),
      location: effectiveLoc,
    });
    if (!extracted.ok || extracted.jobs.length === 0) {
      return;
    }

    const projectedJobs: ProjectedGraphQLJob[] = [];
    for (const item of extracted.jobs) {
      const sanitizedJob = sanitizeProjectedJob(item);
      if (sanitizedJob) {
        projectedJobs.push(sanitizedJob);
      }
    }
    if (projectedJobs.length === 0) {
      return;
    }

    const syntheticBatch = sanitizePassiveSearchBatch({
      captureSeq: ++syntheticSpaSeq,
      navigationEpoch: scheduledEpoch,
      captureKind: 'spa_dom',
      requestUrl: effectiveUrl,
      pageUrl: effectiveUrl,
      sourceFeed: scheduledFeed,
      ...(query !== undefined ? { query } : {}),
      jobs: projectedJobs,
      paging: { hasNextPage: extracted.hasNextPage },
      capturedAt: new Date().toISOString(),
    });
    if (!syntheticBatch) {
      return;
    }
    recordAndMaybeForwardBatch(syntheticBatch);
  };

  const waitForSearchApiSettlement = (
    waitMs: number,
    signal: AbortSignal,
    hasSettledBatch: () => boolean,
  ): Promise<void> => {
    if (waitMs <= 0 || signal.aborted || hasSettledBatch()) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      let sawInFlight = inFlightSearchCount > 0;
      let settleTimer: ReturnType<typeof setTimeout> | null = null;
      const startedAt = Date.now();

      const finish = () => {
        if (settled) return;
        settled = true;
        searchBatchListeners.delete(onUpdate);
        clearTimeout(maxTimer);
        if (settleTimer !== null) {
          clearTimeout(settleTimer);
          settleTimer = null;
        }
        signal.removeEventListener('abort', finish);
        resolve();
      };

      const onUpdate = () => {
        if (signal.aborted || hasSettledBatch()) {
          finish();
          return;
        }
        if (inFlightSearchCount > 0) {
          sawInFlight = true;
          if (settleTimer !== null) {
            clearTimeout(settleTimer);
            settleTimer = null;
          }
          return;
        }
        if (sawInFlight && inFlightSearchCount === 0 && settleTimer === null) {
          const remainingMs = Math.max(0, waitMs - (Date.now() - startedAt));
          settleTimer = setTimeout(finish, Math.min(IN_FLIGHT_SETTLE_DELAY_MS, remainingMs));
        }
      };

      const maxTimer = setTimeout(finish, waitMs);
      searchBatchListeners.add(onUpdate);
      signal.addEventListener('abort', finish, { once: true });
    });
  };

  const onPassiveTap = (event: Event) => {
    const customEvent = event as CustomEvent<unknown>;
    const rawDetail = customEvent.detail;
    if (typeof rawDetail !== 'object' || rawDetail === null || Array.isArray(rawDetail)) {
      return;
    }
    const raw = rawDetail as Record<string, unknown>;
    const kind = raw.kind === 'graphql' || raw.kind === 'xhr' ? raw.kind : null;
    const url = typeof raw.url === 'string' ? raw.url : null;
    const capturedAt = sanitizeCappedString(raw.capturedAt, 64);
    if (!kind || !url || !capturedAt || Number.isNaN(Date.parse(capturedAt))) {
      return;
    }
    const operationName = typeof raw.operationName === 'string' ? raw.operationName : undefined;
    const truncated = typeof raw.truncated === 'boolean' ? raw.truncated : undefined;
    const originalBytes = sanitizeNonNegativeInt(raw.originalBytes);

    let serializedData: string;
    let safeData: unknown;
    try {
      serializedData = JSON.stringify(raw.data ?? null);
      if (serializedData === undefined) {
        serializedData = 'null';
      }
      safeData = JSON.parse(serializedData);
    } catch {
      return;
    }

    const detail: PassiveTapPayload = {
      kind,
      url,
      ...(operationName !== undefined ? { operationName } : {}),
      data: safeData,
      capturedAt,
      ...(truncated !== undefined ? { truncated } : {}),
      ...(originalBytes !== undefined ? { originalBytes } : {}),
    };

    const isDuplicate = recentPassivePayloads.some(({ payload: p }) => {
      if (
        p.capturedAt !== detail.capturedAt ||
        p.kind !== detail.kind ||
        p.url !== detail.url ||
        (p.operationName ?? '') !== (detail.operationName ?? '')
      ) {
        return false;
      }
      try {
        return JSON.stringify(p.data) === serializedData;
      } catch {
        return false;
      }
    });
    if (isDuplicate) {
      return;
    }

    const correlatedEpoch =
      tapEpochByRequestKey.get(normalizeTapCorrelationKey(detail.url, detail.capturedAt)) ??
      currentNavigationEpoch;
    recentPassivePayloads.unshift({ payload: detail, navigationEpoch: correlatedEpoch });
    if (recentPassivePayloads.length > 25) {
      recentPassivePayloads.length = 25;
    }

    void browser.runtime
      .sendMessage({
        kind: detail.kind,
        url: detail.url,
        ...(detail.operationName !== undefined ? { operationName: detail.operationName } : {}),
        data: detail.data,
        capturedAt: detail.capturedAt,
        ...(detail.truncated !== undefined ? { truncated: detail.truncated } : {}),
        ...(detail.originalBytes !== undefined ? { originalBytes: detail.originalBytes } : {}),
        type: 'PASSIVE_TAP_PAYLOAD',
      })
      .catch(() => undefined);
  };

  const onPassiveSearchBatch = (event: Event) => {
    const customEvent = event as CustomEvent<unknown>;
    const batch = sanitizePassiveSearchBatch(customEvent.detail);
    if (!batch) {
      return;
    }
    const correlationKey = normalizeTapCorrelationKey(batch.requestUrl, batch.capturedAt);
    if (
      !tapEpochByRequestKey.has(correlationKey) &&
      tapEpochByRequestKey.size >= MAX_TAP_EPOCH_KEYS
    ) {
      const oldestKey = tapEpochByRequestKey.keys().next().value;
      if (oldestKey !== undefined) {
        tapEpochByRequestKey.delete(oldestKey);
      }
    }
    tapEpochByRequestKey.set(correlationKey, batch.navigationEpoch);
    for (const entry of recentPassivePayloads) {
      if (
        normalizeTapCorrelationKey(entry.payload.url, entry.payload.capturedAt) === correlationKey
      ) {
        entry.navigationEpoch = batch.navigationEpoch;
      }
    }
    recordAndMaybeForwardBatch(batch);
  };

  const onPassiveSearchStatus = (event: Event) => {
    const customEvent = event as CustomEvent<unknown>;
    const rawDetail = customEvent.detail;
    if (!isPlainRecord(rawDetail)) {
      return;
    }
    const nextInFlight = sanitizeNonNegativeInt(rawDetail.inFlightCount);
    const navEpoch =
      typeof rawDetail.navigationEpoch === 'number' &&
      Number.isSafeInteger(rawDetail.navigationEpoch) &&
      rawDetail.navigationEpoch >= 1
        ? rawDetail.navigationEpoch
        : undefined;
    if (nextInFlight === undefined || navEpoch === undefined) {
      return;
    }
    if (navEpoch < currentNavigationEpoch) {
      return;
    }
    if (navEpoch > currentNavigationEpoch) {
      currentNavigationEpoch = navEpoch;
      clearSpaFallbackTimer();
    }
    const prev = inFlightSearchCount;
    inFlightSearchCount = nextInFlight;
    if (inFlightSearchCount === 0 || prev !== inFlightSearchCount) {
      notifySearchListeners();
    }
  };

  const onPassiveSpaNav = (event: Event) => {
    const customEvent = event as CustomEvent<unknown>;
    const rawDetail = customEvent.detail;
    if (!isPlainRecord(rawDetail)) {
      return;
    }
    const navUrl = sanitizeUpworkHttpsUrl(rawDetail.url, false);
    const navEpoch =
      typeof rawDetail.navigationEpoch === 'number' &&
      Number.isSafeInteger(rawDetail.navigationEpoch) &&
      rawDetail.navigationEpoch >= 1
        ? rawDetail.navigationEpoch
        : undefined;
    if (!navUrl || navEpoch === undefined || navEpoch < currentNavigationEpoch) {
      return;
    }

    clearSpaFallbackTimer();
    currentNavigationEpoch = navEpoch;
    notifySearchListeners();

    const parsedNavUrl = new URL(navUrl);
    const feed = resolveSpaFeedFromPathname(parsedNavUrl.pathname);
    if (!feed) {
      return;
    }

    spaFallbackTimer = setTimeout(() => {
      void runSpaDomFallback(navEpoch, feed, navUrl);
    }, SPA_DOM_FALLBACK_DELAY_MS);
  };

  window.addEventListener(PASSIVE_TAP_EVENT, onPassiveTap);
  window.addEventListener(PASSIVE_SEARCH_BATCH_EVENT, onPassiveSearchBatch);
  window.addEventListener(PASSIVE_SEARCH_STATUS_EVENT, onPassiveSearchStatus);
  window.addEventListener(PASSIVE_SPA_NAV_EVENT, onPassiveSpaNav);
  window.dispatchEvent(new CustomEvent(PASSIVE_TAP_READY_EVENT));

  const messageListener = (
    rawMessage: unknown,
    _sender: unknown,
    sendResponse: (response?: unknown) => void,
  ): boolean | undefined => {
    if (typeof rawMessage !== 'object' || rawMessage === null) {
      return undefined;
    }
    const msg = rawMessage as Record<string, unknown>;
    const type = msg.type;

    if (type === 'CONTENT_PROBE_SESSION') {
      sendResponse(detectChallengeOrAuth(document, window.location));
      return false;
    }

    if (type === 'CONTENT_CHECK_PROPOSAL_CONFIRMATION') {
      const probe = detectChallengeOrAuth(document, window.location);
      if (probe.challengeDetected || !probe.loggedIn) {
        sendResponse({
          ok: false,
          challengeDetected: true,
          challengeType: probe.challengeType ?? 'login',
          challengeReason: probe.challengeReason ?? 'Upwork authentication required',
          url: probe.url,
        });
        return false;
      }
      const errEl = document.querySelector("[data-test='form-validation-error']");
      const validationError = isVisibleDomElement(errEl) ? (errEl?.textContent ?? '').trim() : '';
      const bannerEl = document.querySelector(
        "[data-test='proposal-submitted-banner'], [data-test='proposal-confirmation-page']",
      );
      const confirmed = isVisibleDomElement(bannerEl);
      sendResponse({
        ok: true,
        confirmed,
        validationError: validationError || undefined,
        url: window.location.href,
      });
      return false;
    }

    if (type === 'CONTENT_KILL_ABORT') {
      activeAbortController?.abort();
      activeAbortController = null;
      sendResponse({ ok: true });
      return false;
    }

    if (type === 'CONTENT_CHECK_GUARDS') {
      const req = msg as unknown as ContentGuardCheckRequest;
      activeAbortController?.abort();
      activeAbortController = new AbortController();
      void waitForHydration({
        guards: req.guards,
        waitForSelectors: req.waitForSelectors,
        timeoutMs: req.timeoutMs,
        scroll: req.scroll,
        signal: activeAbortController.signal,
        ...(req.waitForSearchApi === true
          ? {
              isApiReady: () =>
                getMatchingSearchBatches({}).some(
                  (b) => b.jobs.length > 0 || Boolean(b.isExplicitEmpty),
                ),
              subscribeApiReady: (cb: () => void) => {
                searchBatchListeners.add(cb);
                return () => {
                  searchBatchListeners.delete(cb);
                };
              },
            }
          : {}),
      }).then((res) => sendResponse(res));
      return true;
    }

    if (type === 'CONTENT_CHECK_HYDRATION') {
      activeAbortController?.abort();
      activeAbortController = new AbortController();
      void waitForHydration({
        waitForSelectors: typeof msg.selector === 'string' ? [msg.selector] : undefined,
        timeoutMs: typeof msg.timeoutMs === 'number' ? msg.timeoutMs : undefined,
        signal: activeAbortController.signal,
      }).then((res) => sendResponse(res));
      return true;
    }

    if (type === 'CONTENT_SCRAPE_SEARCH') {
      const req = msg as unknown as ContentScrapeSearchRequest;
      activeAbortController?.abort();
      const controller = new AbortController();
      activeAbortController = controller;
      const viewName = resolveSearchViewName(req.source);
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        if (controller.signal.aborted) {
          sendResponse({
            ok: false,
            jobs: [],
            hasNextPage: false,
            viewName,
            errorCode: 'ABORTED',
            reason: 'Aborted by kill switch',
          });
          return;
        }

        const preProbe = detectChallengeOrAuth(
          document,
          window.location,
          selectors.auth_and_challenge_guards,
        );
        const waitMs =
          typeof req.waitForApiMs === 'number' && Number.isFinite(req.waitForApiMs)
            ? req.waitForApiMs
            : 0;
        const hasSettledBatch = () =>
          getMatchingSearchBatches({
            capturedSince: req.capturedSince,
            expectedPage: req.expectedPage,
          }).some(
            (b) =>
              b.jobs.length > 0 ||
              Boolean(b.isExplicitEmpty) ||
              (b.graphqlErrorCodes?.length ?? 0) > 0,
          );

        const viewCfg = selectors.views[viewName] ?? selectors.views.search_listings;
        const containerSelectors = viewCfg?.container_selectors ?? ['article.job-tile'];
        const hasDomContainer = containerSelectors.some((sel) => {
          try {
            return Boolean(document.querySelector(sel));
          } catch {
            return false;
          }
        });
        const hasEmptyResultsMarker =
          Boolean(document.querySelector("[data-test='empty-results']")) ||
          (document.body?.textContent ?? '').toLowerCase().includes('0 jobs found');

        if (
          !preProbe.challengeDetected &&
          waitMs > 0 &&
          !hasSettledBatch() &&
          (inFlightSearchCount > 0 || (!hasDomContainer && !hasEmptyResultsMarker))
        ) {
          await waitForSearchApiSettlement(waitMs, controller.signal, hasSettledBatch);
        }

        if (controller.signal.aborted) {
          sendResponse({
            ok: false,
            jobs: [],
            hasNextPage: false,
            viewName,
            errorCode: 'ABORTED',
            reason: 'Aborted by kill switch',
          });
          return;
        }

        const result = extractSearchListings(document, {
          source: req.source,
          query: req.query,
          selectors,
          passivePayloads: getMatchingPassivePayloads({ capturedSince: req.capturedSince }),
          searchBatches: getMatchingSearchBatches({
            capturedSince: req.capturedSince,
            expectedPage: req.expectedPage,
          }),
          location: window.location,
        });
        sendResponse(result);
      })();
      return true;
    }

    if (type === 'CONTENT_SCRAPE_DETAIL') {
      const req = msg as unknown as ContentScrapeDetailRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        const result = extractJobDetail(document, {
          url: req.url ?? window.location.href,
          requireDrawer: req.requireDrawer,
          selectors,
          passivePayloads: recentPassivePayloads.map((e) => e.payload),
          location: window.location,
        });
        sendResponse(result);
      })();
      return true;
    }

    if (type === 'CONTENT_AUDIT_SELECTORS') {
      const req = msg as unknown as ContentAuditSelectorsRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        const probe = detectChallengeOrAuth(
          document,
          window.location,
          selectors.auth_and_challenge_guards,
        );
        if (probe.challengeDetected) {
          sendResponse({
            ok: false,
            errorCode: 'HUMAN_ACTION_REQUIRED',
            challengeType: probe.challengeType ?? 'unknown',
            reason: probe.challengeReason ?? 'Verification challenge detected',
            url: probe.url,
          });
          return;
        }
        const blueprint = buildPageBlueprint(document, {
          url: window.location.href,
          isAuthenticated: req.isAuthenticated ?? probe.loggedIn,
          capturedXhrEndpoints:
            req.capturedXhrEndpoints ?? recentPassivePayloads.map((e) => e.payload.url),
        });
        const baseline = (req.baseline ?? null) as UpWorkPageBlueprint | null;
        const report = new DriftAuditor(blueprint, document, selectors, baseline).audit(req.view);
        sendResponse({
          ok: true,
          report,
          blueprint,
          overall_status: computeOverallAuditStatus(report),
        });
      })();
      return true;
    }

    if (type === 'CONTENT_CAPTURE_UI_DIAGNOSTIC') {
      const req = msg as unknown as ContentCaptureUiDiagnosticRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        const probe = detectChallengeOrAuth(
          document,
          window.location,
          selectors.auth_and_challenge_guards,
        );
        if (probe.challengeDetected) {
          sendResponse({
            ok: false,
            errorCode: 'HUMAN_ACTION_REQUIRED',
            challengeType: probe.challengeType ?? 'unknown',
            reason: probe.challengeReason ?? 'Verification challenge detected',
            url: probe.url,
          });
          return;
        }
        const capture = captureUiDiagnostic(document, {
          url: window.location.href,
          title: document.title,
          view: req.view,
          scope: req.scope ?? 'auto',
          redactPii: req.redactPii ?? true,
          brokenFields: req.brokenFields,
          selectorConfig: selectors,
          baseline: (req.baseline ?? null) as UpWorkPageBlueprint | null,
          isAuthenticated: req.isAuthenticated ?? probe.loggedIn,
          passivePayloads: req.passivePayloads ?? recentPassivePayloads.map((e) => e.payload),
        });
        sendResponse({
          ok: true,
          capture,
        });
      })();
      return true;
    }

    if (type === 'CONTENT_TEST_SELECTOR_PATCH') {
      const req = msg as unknown as ContentTestSelectorPatchRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        const targetDocOrHtml = req.prunedHtml ? req.prunedHtml : document;
        const result = testSelectorPatchOnDocument(
          targetDocOrHtml,
          selectors,
          req.view,
          req.field,
          req.rule,
          window.location.href,
        );
        sendResponse(result);
      })();
      return true;
    }

    if (type === 'CONTENT_SELECTORS_RELOADED') {
      const req = msg as unknown as ContentSelectorsReloadedMessage;
      void (async () => {
        if (buddyInstance) {
          await buddyInstance.refreshSelectorsAndHealthCheck(req.selectorConfig);
        }
        sendResponse({ ok: true });
      })();
      return true;
    }

    if (type === 'CONTENT_PROPOSAL_FILL') {
      const req = msg as unknown as ContentProposalFillRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        const parsed = ProposalFillParamsSchema.safeParse(req.params);
        if (!parsed.success) {
          sendResponse({
            ok: false,
            errorCode: 'INVALID_PARAMS',
            reason: `Invalid proposal fill params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
          });
          return;
        }
        sendResponse(fillProposalForm(document, parsed.data, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_PROPOSAL_SUBMIT') {
      const req = msg as unknown as ContentProposalSubmitRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        const parsed = ProposalSubmitParamsSchema.safeParse(req.params);
        if (!parsed.success) {
          sendResponse({
            ok: false,
            errorCode: 'INVALID_PARAMS',
            reason: `Invalid proposal submit params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
          });
          return;
        }
        sendResponse(submitProposalForm(document, parsed.data, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_PROPOSALS_SYNC') {
      const req = msg as unknown as ContentProposalsSyncRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        sendResponse(extractProposalsList(document, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_MESSAGES_LIST') {
      const req = msg as unknown as ContentMessagesListRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        sendResponse(extractMessageRooms(document, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_MESSAGES_GET') {
      const req = msg as unknown as ContentMessagesGetRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        sendResponse(extractMessageThread(document, req.room_id, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_MESSAGES_DRAFT') {
      const req = msg as unknown as ContentMessagesDraftRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        sendResponse(fillMessageComposer(document, req.body, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_MESSAGES_SEND') {
      const req = msg as unknown as ContentMessagesSendRequest;
      void (async () => {
        const selectors = await resolveContentSelectors(req.selectorConfig);
        sendResponse(sendMessageFromComposer(document, req.body, selectors, window.location));
      })();
      return true;
    }

    if (type === 'CONTENT_EXTRACT_AND_ANALYZE') {
      const saveOnly = msg.action === 'save';
      void (async () => {
        if (buddyInstance) {
          await buddyInstance.triggerCapture(saveOnly);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Overlay not mounted' });
        }
      })();
      return true;
    }

    return undefined;
  };

  browser.runtime.onMessage.addListener(messageListener);

  ctx.onInvalidated(() => {
    invalidated = true;
    clearSpaFallbackTimer();
    searchBatchListeners.clear();
    window.removeEventListener(PASSIVE_TAP_EVENT, onPassiveTap);
    window.removeEventListener(PASSIVE_SEARCH_BATCH_EVENT, onPassiveSearchBatch);
    window.removeEventListener(PASSIVE_SEARCH_STATUS_EVENT, onPassiveSearchStatus);
    window.removeEventListener(PASSIVE_SPA_NAV_EVENT, onPassiveSpaNav);
    browser.runtime.onMessage.removeListener(messageListener);
    activeAbortController?.abort();
    activeAbortController = null;
  });

  return createShadowRootUi(ctx, {
    name: 'upwork-buddy-ui',
    position: 'overlay',
    alignment: 'bottom-right',
    zIndex: 2147483640,
    isolateEvents: ['keydown', 'keyup', 'keypress'],
    onMount(uiContainer, shadow) {
      const buddy = new UpworkBuddy({
        uiRoot: uiContainer,
        styleRoot: shadow,
        skipLegacyStyleTag: true,
        alwaysShowToolbar: true,
        ctx,
      });
      buddyInstance = buddy;

      void browser.runtime
        .sendMessage({ type: 'GET_RUNTIME_STATUS' })
        .then((res) => {
          const status = res as Partial<RuntimeStatusSnapshot> | undefined;
          if (status && typeof status === 'object') {
            buddy.setToolbarStatus(
              Boolean(status.wsConnected),
              status.policyMode ?? 'confirm_in_ui',
              Boolean(status.humanActionRequired),
            );
          }
        })
        .catch(() => undefined);

      return buddy;
    },
    onRemove(buddy) {
      buddy?.destroy();
      buddyInstance = null;
    },
  });
}
