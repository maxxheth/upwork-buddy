import type {
  ActivityLogEntry,
  PassiveSearchBatch,
  ProjectedGraphQLJob,
  SearchFeedKind,
  SearchPaginationMeta,
  WsSearchObservedJob,
  WsSearchObservedPagination,
} from '../shared/protocol';

export interface LiveSearchStreamDeps {
  getTabControllerState: () => { automationTabId: number | null; busy: boolean };
  isKillSwitchActive: () => boolean;
  isLiveStreamEnabled?: () => boolean;
  sendWsNotification: (method: string, params: Record<string, unknown>) => boolean;
  recordActivity?: (entry: Omit<ActivityLogEntry, 'id' | 'timestamp'>) => void;
  debounceMs?: number;
  dedupTtlMs?: number;
  maxDedupEntries?: number;
  maxCachedBatchesPerTab?: number;
  nowFn?: () => number;
}

export type LiveBatchSuppressionReason =
  | 'kill_switch'
  | 'disabled'
  | 'active_sweep'
  | 'graphql_error'
  | 'empty'
  | 'deduped';

export interface HandleIncomingBatchResult {
  cached: boolean;
  queued: boolean;
  suppressedReason?: LiveBatchSuppressionReason;
}

interface DedupEntry {
  pushedAt: number;
  hasConnects: boolean;
  hasDescription: boolean;
}

interface PendingFlush {
  key: string;
  tabId: number | null;
  pageUrl: string;
  sourceFeed: SearchFeedKind;
  query: string;
  operationName?: string;
  captureKind: 'graphql' | 'xhr' | 'spa_dom';
  paging?: SearchPaginationMeta;
  capturedAt: string;
  jobsById: Map<string, ProjectedGraphQLJob>;
  timer: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_DEDUP_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_DEDUP_ENTRIES = 1000;
const DEFAULT_MAX_CACHED_BATCHES_PER_TAB = 10;

const CAPTURE_KIND_PRIORITY: Record<'graphql' | 'xhr' | 'spa_dom', number> = {
  graphql: 3,
  xhr: 2,
  spa_dom: 1,
};

function hasConnectsField(job: ProjectedGraphQLJob): boolean {
  return typeof job.connects_required === 'number' && Number.isFinite(job.connects_required);
}

function hasDescriptionField(job: ProjectedGraphQLJob): boolean {
  return typeof job.job_description === 'string' && job.job_description.trim().length > 0;
}

function mergeProjectedJobs(
  existing: ProjectedGraphQLJob,
  incoming: ProjectedGraphQLJob,
): ProjectedGraphQLJob {
  const merged: ProjectedGraphQLJob = { ...existing };

  for (const [rawKey, rawVal] of Object.entries(incoming)) {
    if (rawVal === undefined || rawVal === null) {
      continue;
    }
    const key = rawKey as keyof ProjectedGraphQLJob;
    if (key === 'job_description') {
      const nextDesc = typeof rawVal === 'string' ? rawVal : '';
      const prevDesc = typeof merged.job_description === 'string' ? merged.job_description : '';
      if (nextDesc.length >= prevDesc.length && nextDesc.length > 0) {
        merged.job_description = nextDesc;
      }
      continue;
    }
    if (typeof rawVal === 'string') {
      if (rawVal.trim().length > 0 || merged[key] === undefined) {
        (merged as unknown as Record<string, unknown>)[key] = rawVal;
      }
      continue;
    }
    (merged as unknown as Record<string, unknown>)[key] = rawVal;
  }

  return merged;
}

function mapWirePagination(paging?: SearchPaginationMeta): WsSearchObservedPagination | undefined {
  if (!paging) {
    return undefined;
  }
  const out: WsSearchObservedPagination = {};
  if (
    typeof paging.totalCount === 'number' &&
    Number.isInteger(paging.totalCount) &&
    paging.totalCount >= 0
  ) {
    out.total_count = paging.totalCount;
  }
  if (typeof paging.offset === 'number' && Number.isInteger(paging.offset) && paging.offset >= 0) {
    out.offset = paging.offset;
  }
  if (typeof paging.count === 'number' && Number.isInteger(paging.count) && paging.count >= 0) {
    out.count = paging.count;
  }
  if (typeof paging.page === 'number' && Number.isInteger(paging.page) && paging.page >= 0) {
    out.page = paging.page;
  }
  if (
    typeof paging.perPage === 'number' &&
    Number.isInteger(paging.perPage) &&
    paging.perPage >= 0
  ) {
    out.per_page = paging.perPage;
  }
  if (typeof paging.hasNextPage === 'boolean') {
    out.has_next_page = paging.hasNextPage;
  }
  if (typeof paging.nextCursor === 'string' && paging.nextCursor.trim().length > 0) {
    out.next_cursor = paging.nextCursor.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mapWireJob(
  job: ProjectedGraphQLJob,
  sourceFeed: SearchFeedKind,
  trimmedQuery: string,
): WsSearchObservedJob {
  const canonicalUrl =
    job.canonical_url?.trim() || `https://www.upwork.com/jobs/${job.upwork_job_id}/`;
  const url = job.url?.trim() || canonicalUrl;

  const out: WsSearchObservedJob = {
    upwork_job_id: job.upwork_job_id,
    canonical_url: canonicalUrl,
    url,
    job_url: url,
    source: 'chrome_live_stream',
    source_feed: sourceFeed,
    status: 'ready',
  };

  if (trimmedQuery) {
    out.source_query = trimmedQuery;
  }

  if (job.job_title !== undefined) out.job_title = job.job_title;
  if (job.job_description !== undefined) out.job_description = job.job_description;
  if (job.contract_type !== undefined) out.contract_type = job.contract_type;
  if (job.budget !== undefined) out.budget = job.budget;
  if (job.budget_amount !== undefined) out.budget_amount = job.budget_amount;
  if (job.rate_range !== undefined) out.rate_range = job.rate_range;
  if (job.rate_min !== undefined) out.rate_min = job.rate_min;
  if (job.rate_max !== undefined) out.rate_max = job.rate_max;
  if (job.experience_level !== undefined) out.experience_level = job.experience_level;
  if (job.duration !== undefined) out.duration = job.duration;
  if (job.hours_per_week !== undefined) out.hours_per_week = job.hours_per_week;
  if (job.skills !== undefined) out.skills = job.skills;
  if (job.posted_text !== undefined) out.posted_text = job.posted_text;
  if (typeof job.posted_at_est === 'string' && job.posted_at_est.trim().length > 0) {
    out.posted_at_est = job.posted_at_est.trim();
  }
  if (job.proposals_tier !== undefined) out.proposals_tier = job.proposals_tier;
  if (typeof job.proposals_count === 'number' && Number.isFinite(job.proposals_count)) {
    out.proposals_count = job.proposals_count;
  }
  if (typeof job.connects_required === 'number' && Number.isFinite(job.connects_required)) {
    out.connects_required = job.connects_required;
  }
  if (job.client_country !== undefined) out.client_country = job.client_country;
  if (typeof job.client_rating === 'number' && Number.isFinite(job.client_rating)) {
    out.client_rating = job.client_rating;
  }
  if (typeof job.client_reviews === 'number' && Number.isFinite(job.client_reviews)) {
    out.client_reviews = job.client_reviews;
  }
  if (job.client_spent !== undefined) out.client_spent = job.client_spent;
  if (typeof job.client_spent_usd === 'number' && Number.isFinite(job.client_spent_usd)) {
    out.client_spent_usd = job.client_spent_usd;
  }
  if (typeof job.client_hires === 'number' && Number.isFinite(job.client_hires)) {
    out.client_hires = job.client_hires;
  }
  if (typeof job.client_hire_rate === 'number' && Number.isFinite(job.client_hire_rate)) {
    out.client_hire_rate = job.client_hire_rate;
  }
  if (typeof job.payment_verified === 'boolean') {
    out.payment_verified = job.payment_verified;
  }

  return out;
}

export class LiveSearchStream {
  private readonly deps: LiveSearchStreamDeps;
  private readonly isLiveStreamEnabled: () => boolean;
  private readonly debounceMs: number;
  private readonly dedupTtlMs: number;
  private readonly maxDedupEntries: number;
  private readonly maxCachedBatchesPerTab: number;
  private readonly nowFn: () => number;

  private readonly tabBatches = new Map<number, PassiveSearchBatch[]>();
  private readonly recentlyPushedJobs = new Map<string, DedupEntry>();
  private readonly pendingFlushes = new Map<string, PendingFlush>();

  constructor(deps: LiveSearchStreamDeps) {
    this.deps = deps;
    this.isLiveStreamEnabled = deps.isLiveStreamEnabled ?? (() => true);
    this.debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.dedupTtlMs = deps.dedupTtlMs ?? DEFAULT_DEDUP_TTL_MS;
    this.maxDedupEntries = Math.max(1, deps.maxDedupEntries ?? DEFAULT_MAX_DEDUP_ENTRIES);
    this.maxCachedBatchesPerTab = Math.max(
      1,
      deps.maxCachedBatchesPerTab ?? DEFAULT_MAX_CACHED_BATCHES_PER_TAB,
    );
    this.nowFn = deps.nowFn ?? (() => Date.now());
  }

  handleIncomingBatch(
    tabId: number | null | undefined,
    batch: PassiveSearchBatch,
  ): HandleIncomingBatchResult {
    const validTabId =
      typeof tabId === 'number' && Number.isInteger(tabId) && tabId >= 0 ? tabId : null;

    let cached = false;
    if (validTabId !== null) {
      const existing = this.tabBatches.get(validTabId) ?? [];
      const next = [...existing, batch].slice(-this.maxCachedBatchesPerTab);
      this.tabBatches.set(validTabId, next);
      cached = true;
    }

    const suppression = this.getLiveSuppressionReason(validTabId, batch);
    if (suppression) {
      return { cached, queued: false, suppressedReason: suppression };
    }

    if (batch.jobs.length === 0) {
      return { cached, queued: false, suppressedReason: 'empty' };
    }

    const now = this.nowFn();
    this.pruneExpiredDedup(now);

    const eligibleJobs = batch.jobs.filter((job) => this.shouldIncludeJob(job, now));
    if (eligibleJobs.length === 0) {
      return { cached, queued: false, suppressedReason: 'deduped' };
    }

    const trimmedQuery = (batch.query ?? '').trim();
    const key = `${validTabId ?? 'none'}::${batch.sourceFeed}::${trimmedQuery}`;
    const existingPending = this.pendingFlushes.get(key);

    if (existingPending) {
      if (existingPending.timer !== null) {
        clearTimeout(existingPending.timer);
        existingPending.timer = null;
      }
      existingPending.pageUrl = batch.pageUrl;
      if (batch.operationName?.trim()) {
        existingPending.operationName = batch.operationName.trim();
      }
      if (
        CAPTURE_KIND_PRIORITY[batch.captureKind] >=
        CAPTURE_KIND_PRIORITY[existingPending.captureKind]
      ) {
        existingPending.captureKind = batch.captureKind;
      }
      if (batch.paging) {
        existingPending.paging = batch.paging;
      }
      if (batch.capturedAt?.trim()) {
        existingPending.capturedAt = batch.capturedAt.trim();
      }
      for (const job of eligibleJobs) {
        const prevJob = existingPending.jobsById.get(job.upwork_job_id);
        existingPending.jobsById.set(
          job.upwork_job_id,
          prevJob ? mergeProjectedJobs(prevJob, job) : job,
        );
      }

      if (this.debounceMs <= 0) {
        this.flushPending(key);
      } else {
        existingPending.timer = setTimeout(() => {
          this.flushPending(key);
        }, this.debounceMs);
      }
      return { cached, queued: true };
    }

    const jobsById = new Map<string, ProjectedGraphQLJob>();
    for (const job of eligibleJobs) {
      const prevJob = jobsById.get(job.upwork_job_id);
      jobsById.set(job.upwork_job_id, prevJob ? mergeProjectedJobs(prevJob, job) : job);
    }

    const pending: PendingFlush = {
      key,
      tabId: validTabId,
      pageUrl: batch.pageUrl,
      sourceFeed: batch.sourceFeed,
      query: trimmedQuery,
      ...(batch.operationName?.trim() ? { operationName: batch.operationName.trim() } : {}),
      captureKind: batch.captureKind,
      ...(batch.paging ? { paging: batch.paging } : {}),
      capturedAt: batch.capturedAt?.trim() ?? '',
      jobsById,
      timer: null,
    };

    this.pendingFlushes.set(key, pending);

    if (this.debounceMs <= 0) {
      this.flushPending(key);
    } else {
      pending.timer = setTimeout(() => {
        this.flushPending(key);
      }, this.debounceMs);
    }

    return { cached, queued: true };
  }

  getBatchesForTab(tabId: number, sinceIso?: string): PassiveSearchBatch[] {
    const list = this.tabBatches.get(tabId);
    if (!list || list.length === 0) {
      return [];
    }
    if (!sinceIso) {
      return [...list];
    }
    const sinceMs = Date.parse(sinceIso);
    return list.filter((batch) => {
      const capturedMs = Date.parse(batch.capturedAt);
      if (Number.isFinite(sinceMs) && Number.isFinite(capturedMs)) {
        return capturedMs >= sinceMs;
      }
      return batch.capturedAt >= sinceIso;
    });
  }

  clearTab(tabId: number): void {
    this.tabBatches.delete(tabId);
    for (const [key, pending] of this.pendingFlushes.entries()) {
      if (pending.tabId === tabId) {
        if (pending.timer !== null) {
          clearTimeout(pending.timer);
        }
        this.pendingFlushes.delete(key);
      }
    }
  }

  cancelPendingFlushes(): void {
    for (const pending of this.pendingFlushes.values()) {
      if (pending.timer !== null) {
        clearTimeout(pending.timer);
      }
    }
    this.pendingFlushes.clear();
  }

  private getLiveSuppressionReason(
    tabId: number | null,
    batch?: PassiveSearchBatch,
  ): 'kill_switch' | 'disabled' | 'active_sweep' | 'graphql_error' | null {
    if (this.deps.isKillSwitchActive()) {
      return 'kill_switch';
    }
    if (this.isLiveStreamEnabled() === false) {
      return 'disabled';
    }
    const tabState = this.deps.getTabControllerState();
    if (
      tabId !== null &&
      tabState.automationTabId !== null &&
      tabId === tabState.automationTabId &&
      tabState.busy
    ) {
      return 'active_sweep';
    }
    if ((batch?.graphqlErrorCodes?.length ?? 0) > 0) {
      return 'graphql_error';
    }
    return null;
  }

  private pruneExpiredDedup(now: number): void {
    for (const [jobId, entry] of this.recentlyPushedJobs.entries()) {
      if (now - entry.pushedAt >= this.dedupTtlMs) {
        this.recentlyPushedJobs.delete(jobId);
      }
    }
  }

  private shouldIncludeJob(job: ProjectedGraphQLJob, now: number): boolean {
    if (!job.job_title?.trim()) {
      return false;
    }
    const prev = this.recentlyPushedJobs.get(job.upwork_job_id);
    if (!prev) {
      return true;
    }
    if (now - prev.pushedAt >= this.dedupTtlMs) {
      this.recentlyPushedJobs.delete(job.upwork_job_id);
      return true;
    }
    if (!prev.hasConnects && hasConnectsField(job)) {
      return true;
    }
    if (!prev.hasDescription && hasDescriptionField(job)) {
      return true;
    }
    return false;
  }

  private markJobsPushed(jobs: ProjectedGraphQLJob[], now: number): void {
    for (const job of jobs) {
      const prev = this.recentlyPushedJobs.get(job.upwork_job_id);
      if (prev) {
        this.recentlyPushedJobs.delete(job.upwork_job_id);
      }
      this.recentlyPushedJobs.set(job.upwork_job_id, {
        pushedAt: now,
        hasConnects: hasConnectsField(job) || prev?.hasConnects === true,
        hasDescription: hasDescriptionField(job) || prev?.hasDescription === true,
      });
    }
    while (this.recentlyPushedJobs.size > this.maxDedupEntries) {
      const oldestKey = this.recentlyPushedJobs.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.recentlyPushedJobs.delete(oldestKey);
    }
  }

  private flushPending(key: string): void {
    const pending = this.pendingFlushes.get(key);
    if (!pending) {
      return;
    }
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    this.pendingFlushes.delete(key);

    if (this.getLiveSuppressionReason(pending.tabId) !== null) {
      return;
    }

    const now = this.nowFn();
    this.pruneExpiredDedup(now);

    const jobsToSend = Array.from(pending.jobsById.values()).filter((job) =>
      this.shouldIncludeJob(job, now),
    );
    if (jobsToSend.length === 0) {
      return;
    }

    const wirePaging = mapWirePagination(pending.paging);
    const wireJobs = jobsToSend.map((job) => mapWireJob(job, pending.sourceFeed, pending.query));

    const params: Record<string, unknown> = {
      ...(pending.tabId !== null ? { tab_id: pending.tabId } : {}),
      page_url: pending.pageUrl,
      source_feed: pending.sourceFeed,
      ...(pending.query ? { query: pending.query } : {}),
      ...(pending.operationName ? { operation_name: pending.operationName } : {}),
      capture_kind: pending.captureKind,
      ...(wirePaging ? { paging: wirePaging } : {}),
      jobs: wireJobs,
      ...(pending.capturedAt ? { captured_at: pending.capturedAt } : {}),
    };

    const sent = this.deps.sendWsNotification('search.observed', params);
    if (!sent) {
      return;
    }

    this.markJobsPushed(jobsToSend, now);
    this.deps.recordActivity?.({
      source: 'ws',
      action: 'search.observed',
      detail: `Streamed ${wireJobs.length} live job(s) from ${pending.sourceFeed}${pending.query ? ` (${pending.query})` : ''}`,
      status: 'ok',
    });
  }
}
