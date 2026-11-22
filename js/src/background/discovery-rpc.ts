import { browser } from 'wxt/browser';
import { buildSearchUrl, resolveSearchViewName } from '../content/adapters/search-adapter';
import { testSelectorPatchOnDocument } from '../content/ui-capture';
import type {
  ActivityLogEntry,
  ChallengeType,
  DiagnosticScope,
  DriftAuditReport,
  PassiveTapPayload,
  SelectorPatchTestResult,
  UiDiagnosticCapture,
  UpWorkPageBlueprint,
} from '../shared/protocol';
import {
  DetailEnrichRequestSchema,
  type JobUpsertPayload,
  SearchRunRequestSchema,
} from '../shared/schemas';
import {
  BUNDLED_SELECTORS,
  type FieldSelectorRule,
  FieldSelectorRuleSchema,
  type SelectorConfig,
} from '../shared/selectors';
import { selectorBaselinesItem } from '../shared/storage-items';
import type { AutomationTabController } from './tab-controller';
import { BridgeRpcError, HumanActionRequiredError } from './ws-client';

export interface DiscoveryRpcDeps {
  tabController: AutomationTabController;
  proxyFetch: (path: string, init?: RequestInit) => Promise<Response>;
  getSelectors: (forceRefresh?: boolean) => Promise<SelectorConfig>;
  sendTabMessage?: (tabId: number, message: unknown) => Promise<unknown>;
  queryTabs?: (queryInfo: {
    active?: boolean;
    currentWindow?: boolean;
    url?: string;
  }) => Promise<Array<{ id?: number; url?: string; active?: boolean; windowId?: number }>>;
  captureVisibleTab?: (windowId: number) => Promise<string>;
  recordActivity?: (entry: Omit<ActivityLogEntry, 'id' | 'timestamp'>) => void;
  getPassivePayloads?: () => PassiveTapPayload[];
}

export type ProgressCallback = (
  stage: string,
  current: number,
  total: number,
  message?: string,
) => void;

interface ContentSearchReply {
  ok: boolean;
  jobs?: JobUpsertPayload[];
  hasNextPage?: boolean;
  errorCode?: string;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

interface ContentDetailReply {
  ok: boolean;
  detail?: Record<string, unknown>;
  payload?: JobUpsertPayload;
  errorCode?: string;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

interface ContentAuditReply {
  ok: boolean;
  report?: DriftAuditReport;
  blueprint?: UpWorkPageBlueprint;
  overall_status?: string;
  errorCode?: string;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

interface ContentCaptureDiagnosticReply {
  ok: boolean;
  capture?: UiDiagnosticCapture;
  errorCode?: string;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

function defaultSendTabMessage(tabId: number, message: unknown): Promise<unknown> {
  return browser.tabs.sendMessage(tabId, message);
}

function defaultQueryTabs(queryInfo: {
  active?: boolean;
  currentWindow?: boolean;
  url?: string;
}): Promise<Array<{ id?: number; url?: string; active?: boolean; windowId?: number }>> {
  return browser.tabs.query(queryInfo);
}

async function defaultCaptureVisibleTab(windowId: number): Promise<string> {
  return browser.tabs.captureVisibleTab(windowId, { format: 'png' });
}

async function findUpworkTab(
  deps: DiscoveryRpcDeps,
  preferredTabId?: number,
): Promise<{ id: number; url: string; windowId?: number } | null> {
  const queryTabs = deps.queryTabs ?? defaultQueryTabs;

  if (typeof preferredTabId === 'number') {
    const allTabs = await queryTabs({}).catch(() => []);
    const exact = allTabs.find(
      (t) =>
        t.id === preferredTabId &&
        typeof t.url === 'string' &&
        t.url.startsWith('https://www.upwork.com/'),
    );
    if (exact && typeof exact.id === 'number' && typeof exact.url === 'string') {
      return { id: exact.id, url: exact.url, windowId: exact.windowId };
    }
  }

  const activeTabs = await queryTabs({ active: true, currentWindow: true }).catch(() => []);
  const activeUpwork = activeTabs.find(
    (t) =>
      typeof t.id === 'number' &&
      typeof t.url === 'string' &&
      t.url.startsWith('https://www.upwork.com/'),
  );
  if (activeUpwork && typeof activeUpwork.id === 'number' && typeof activeUpwork.url === 'string') {
    return { id: activeUpwork.id, url: activeUpwork.url, windowId: activeUpwork.windowId };
  }

  const upworkTabs = await queryTabs({ url: 'https://www.upwork.com/*' }).catch(() => []);
  const candidate =
    upworkTabs.find((t) => t.active && typeof t.id === 'number' && typeof t.url === 'string') ??
    upworkTabs.find((t) => typeof t.id === 'number' && typeof t.url === 'string');
  if (candidate && typeof candidate.id === 'number' && typeof candidate.url === 'string') {
    return { id: candidate.id, url: candidate.url, windowId: candidate.windowId };
  }
  return null;
}

export async function executeSearchSweep(
  deps: DiscoveryRpcDeps,
  rawParams: Record<string, unknown>,
  sendProgress?: ProgressCallback,
  requestId = `search-${Date.now()}`,
): Promise<Record<string, unknown>> {
  const parsed = SearchRunRequestSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw new BridgeRpcError(
      'INVALID_PARAMS',
      `Invalid search params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      -32602,
    );
  }
  const params = parsed.data;
  const selectors = await deps.getSelectors();
  const sendTab = deps.sendTabMessage ?? defaultSendTabMessage;

  const rawQueries =
    params.queries && params.queries.length > 0 ? params.queries : [params.query ?? ''];
  const effectiveQueries: string[] = [];
  const seenQ = new Set<string>();
  for (const q of rawQueries) {
    const trimmed = q.trim();
    if (!seenQ.has(trimmed)) {
      seenQ.add(trimmed);
      effectiveQueries.push(trimmed);
    }
  }
  if (effectiveQueries.length === 0) {
    effectiveQueries.push('');
  }

  const viewName = resolveSearchViewName(params.source);
  const containerSelectors = selectors.views[viewName]?.container_selectors ?? ['article.job-tile'];
  const waitForSelectors = Array.from(
    new Set([...containerSelectors, "[data-test*='JobsCount']", "[data-test='empty-results']"]),
  );
  const totalExpectedPages = effectiveQueries.length * params.max_pages;

  return deps.tabController.runSerialized(requestId, async (signal) => {
    const collected: JobUpsertPayload[] = [];
    const seenJobKeys = new Set<string>();
    let navCount = 0;
    let stoppedReason = 'completed';

    try {
      outer: for (const query of effectiveQueries) {
        for (let pageOffset = 0; pageOffset < params.max_pages; pageOffset++) {
          if (signal.aborted) {
            throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
          }
          const pageNum = params.start_page + pageOffset;
          if (navCount > 0) {
            await deps.tabController.pace(signal);
          }

          const targetUrl = buildSearchUrl({
            source: params.source,
            query,
            sort: params.sort,
            per_page: params.per_page,
            contractor_tier: params.contractor_tier,
            contract_type: params.contract_type,
            proposal_tiers: params.proposal_tiers,
            budget_min: params.budget_min,
            budget_max: params.budget_max,
            hourly_rate_min: params.hourly_rate_min,
            hourly_rate_max: params.hourly_rate_max,
            payment_verified_only: params.payment_verified_only,
            category: params.category,
            search_url: params.search_url,
            page: pageNum,
          });

          navCount += 1;
          sendProgress?.('search', navCount, totalExpectedPages, `Scanning page ${pageNum}`);

          const nav = await deps.tabController.navigateAndWaitForHydration(
            targetUrl,
            {
              guards: selectors.auth_and_challenge_guards,
              waitForSelectors,
              scroll: { steps: 4, intervalMs: 300 },
            },
            signal,
          );

          const reply = (await sendTab(nav.tabId, {
            type: 'CONTENT_SCRAPE_SEARCH',
            source: params.source,
            query,
            selectorConfig: selectors,
          })) as ContentSearchReply | undefined;

          if (!reply) {
            stoppedReason = 'empty_reply';
            break outer;
          }
          if (!reply.ok && reply.errorCode === 'HUMAN_ACTION_REQUIRED') {
            throw new HumanActionRequiredError(
              reply.reason ?? 'Human verification required',
              reply.challengeType ?? 'unknown',
              reply.url ?? targetUrl,
            );
          }

          const pageJobs = reply.jobs ?? [];
          if (pageJobs.length === 0) {
            stoppedReason = 'empty_page';
            break;
          }

          let addedOnPage = 0;
          for (const job of pageJobs) {
            const key = job.upwork_job_id || job.canonical_url || job.url || job.job_title || '';
            if (!key || seenJobKeys.has(key)) {
              continue;
            }
            seenJobKeys.add(key);
            collected.push(job);
            addedOnPage += 1;
            if (params.target_jobs && collected.length >= params.target_jobs) {
              stoppedReason = 'target_reached';
              break outer;
            }
          }

          if (addedOnPage === 0) {
            stoppedReason = 'no_new_jobs';
            break;
          }

          if (params.source !== 'search' && !reply.hasNextPage) {
            stoppedReason = 'end_of_feed';
            break;
          }
        }
      }
    } catch (err) {
      // Preserve already-scraped earlier pages when a challenge halts a multi-page sweep;
      // do NOT flush on TaskAbortedError (kill switch) or unexpected errors.
      if (err instanceof HumanActionRequiredError && collected.length > 0) {
        await deps
          .proxyFetch('/api/jobs/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jobs: collected,
              filters: params.filters,
              filter_stage: 'pre_enrichment',
              sort_by_score: true,
            }),
          })
          .catch(() => undefined);
        deps.recordActivity?.({
          source: 'tab',
          action: 'jobs.search',
          detail: `Halted on challenge (${err.challengeType}); flushed ${collected.length} partial job(s) across ${navCount} page(s)`,
          status: 'warn',
        });
      }
      throw err;
    }

    let ingestSummary: Record<string, unknown> | undefined;
    if (params.auto_ingest && collected.length > 0) {
      const res = await deps.proxyFetch('/api/jobs/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobs: collected,
          filters: params.filters,
          filter_stage: 'pre_enrichment',
          sort_by_score: true,
        }),
      });
      if (res.ok) {
        ingestSummary = (await res.json()) as Record<string, unknown>;
      }
    }

    deps.recordActivity?.({
      source: 'tab',
      action: 'jobs.search',
      detail: `Scraped ${collected.length} jobs across ${navCount} page(s) (${stoppedReason})`,
      status: 'ok',
    });

    return {
      ok: true,
      jobs: collected,
      total_scraped: collected.length,
      pages_scanned: navCount,
      stopped_reason: stoppedReason,
      ...(ingestSummary ? { ingest: ingestSummary } : {}),
    };
  });
}

function normalizeDetailTargetUrl(rawUrl?: string, upworkJobId?: string): string | null {
  if (rawUrl && rawUrl.trim()) {
    return rawUrl.trim();
  }
  if (upworkJobId && upworkJobId.trim()) {
    const id = upworkJobId.trim().startsWith('~') ? upworkJobId.trim() : `~${upworkJobId.trim()}`;
    return `https://www.upwork.com/jobs/${id}/`;
  }
  return null;
}

export async function executeDetailEnrich(
  deps: DiscoveryRpcDeps,
  rawParams: Record<string, unknown>,
  sendProgress?: ProgressCallback,
  requestId = `detail-${Date.now()}`,
): Promise<Record<string, unknown>> {
  const parsed = DetailEnrichRequestSchema.safeParse(rawParams);
  if (!parsed.success) {
    throw new BridgeRpcError(
      'INVALID_PARAMS',
      `Invalid detail enrich params: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      -32602,
    );
  }
  const params = parsed.data;
  const targets: string[] = [];
  if (params.urls && params.urls.length > 0) {
    for (const u of params.urls) {
      if (u.trim()) targets.push(u.trim());
    }
  } else {
    const single = normalizeDetailTargetUrl(params.url, params.upwork_job_id);
    if (single) targets.push(single);
  }

  if (targets.length === 0) {
    throw new BridgeRpcError(
      'INVALID_PARAMS',
      'At least one url, upwork_job_id, or urls entry is required',
      -32602,
    );
  }

  const boundedTargets =
    params.max_jobs && params.max_jobs > 0 ? targets.slice(0, params.max_jobs) : targets;
  const selectors = await deps.getSelectors();
  const sendTab = deps.sendTabMessage ?? defaultSendTabMessage;
  const detailWaitSelectors = [
    "[data-test='Description']",
    '.job-details-content',
    '.job-details-card',
    'h1',
  ];

  return deps.tabController.runSerialized(requestId, async (signal) => {
    const payloads: JobUpsertPayload[] = [];
    const details: Array<Record<string, unknown>> = [];
    const notFoundUrls: string[] = [];
    let consecutiveNotFound = 0;
    let stoppedReason = 'completed';

    for (let i = 0; i < boundedTargets.length; i++) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Aborted');
      }
      if (i > 0) {
        await deps.tabController.pace(signal);
      }

      const targetUrl = boundedTargets[i];
      sendProgress?.('enrich', i + 1, boundedTargets.length, `Enriching ${targetUrl}`);

      const nav = await deps.tabController.navigateAndWaitForHydration(
        targetUrl,
        {
          guards: selectors.auth_and_challenge_guards,
          waitForSelectors: detailWaitSelectors,
        },
        signal,
      );

      const reply = (await sendTab(nav.tabId, {
        type: 'CONTENT_SCRAPE_DETAIL',
        url: targetUrl,
        requireDrawer: params.require_drawer,
        selectorConfig: selectors,
      })) as ContentDetailReply | undefined;

      if (!reply) {
        notFoundUrls.push(targetUrl);
        continue;
      }

      if (!reply.ok) {
        if (reply.errorCode === 'HUMAN_ACTION_REQUIRED') {
          throw new HumanActionRequiredError(
            reply.reason ?? 'Human verification required',
            reply.challengeType ?? 'unknown',
            reply.url ?? targetUrl,
          );
        }
        if (reply.errorCode === 'RATE_LIMITED') {
          stoppedReason = 'rate_limited';
          break;
        }
        if (reply.errorCode === 'NOT_FOUND' || reply.errorCode === 'MISSING_SIGNALS') {
          notFoundUrls.push(targetUrl);
          consecutiveNotFound += 1;
          if (boundedTargets.length === 1) {
            return {
              ok: false,
              not_found: true,
              error: reply.reason ?? 'Job not found or unavailable',
              jobs: [],
              not_found_urls: notFoundUrls,
              stopped_reason: 'not_found',
            };
          }
          if (consecutiveNotFound >= 3) {
            stoppedReason = 'consecutive_not_found';
            break;
          }
          continue;
        }
      }

      consecutiveNotFound = 0;
      if (reply.payload) {
        payloads.push(reply.payload);
      }
      if (reply.detail) {
        details.push(reply.detail);
      }
    }

    if (params.persist !== false && payloads.length > 0) {
      if (payloads.length === 1) {
        await deps
          .proxyFetch('/api/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payloads[0]),
          })
          .catch(() => undefined);
      } else {
        await deps
          .proxyFetch('/api/jobs/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobs: payloads }),
          })
          .catch(() => undefined);
      }
    }

    deps.recordActivity?.({
      source: 'tab',
      action: 'jobs.detail',
      detail: `Enriched ${payloads.length}/${boundedTargets.length} jobs (${stoppedReason})`,
      status: stoppedReason === 'rate_limited' ? 'warn' : 'ok',
    });

    return {
      ok: true,
      job: payloads[0] ?? null,
      detail: details[0] ?? null,
      jobs: payloads,
      enriched_count: payloads.length,
      not_found_urls: notFoundUrls,
      stopped_reason: stoppedReason,
    };
  });
}

function extractLowerPathname(rawUrl: string): string {
  try {
    return new URL(rawUrl, 'https://www.upwork.com').pathname.toLowerCase();
  } catch {
    return (rawUrl.split(/[?#]/)[0] ?? '').toLowerCase();
  }
}

function inferAuditViewType(view?: string, tabUrl = ''): string {
  const v = (view ?? '').trim();
  if (v) {
    if (v === 'search_results') return 'search_listings';
    return v;
  }
  const pathname = extractLowerPathname(tabUrl);
  if (/\/ab\/messages\/rooms\/[^/]+/.test(pathname)) return 'messages_thread';
  if (pathname.includes('/ab/messages')) return 'messages_rooms';
  if (pathname.includes('/nx/proposals/job/')) return 'proposal_apply';
  if (pathname.includes('/nx/proposals')) return 'proposals_list';
  if (pathname.includes('/search/jobs')) return 'search_listings';
  if (pathname.includes('best-matches')) return 'best_matches';
  if (pathname.includes('most-recent')) return 'most_recent';
  if (pathname.includes('saved-jobs')) return 'saved_jobs';
  if (pathname.includes('/jobs/') || pathname.includes('_~')) return 'job_detail';
  return 'search_listings';
}

async function fetchStoredBaseline(
  proxyFetch: DiscoveryRpcDeps['proxyFetch'],
  viewType: string,
): Promise<UpWorkPageBlueprint | null> {
  const candidates =
    viewType === 'search_results'
      ? ['search_results', 'search_listings']
      : viewType === 'search_listings'
        ? ['search_listings', 'search_results']
        : [viewType];

  for (const candidate of candidates) {
    try {
      const res = await proxyFetch(
        `/api/selector-audits?view_type=${encodeURIComponent(candidate)}&latest=true&limit=1`,
        { method: 'GET' },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          audits?: Array<{ baseline?: UpWorkPageBlueprint | null }>;
        };
        const found = data.audits?.[0]?.baseline;
        if (found && typeof found === 'object') {
          return found;
        }
      }
    } catch {
      // ignore offline or DB error
    }
  }

  try {
    const localBaselines = await selectorBaselinesItem.getValue();
    for (const candidate of candidates) {
      const cached = localBaselines?.[candidate];
      if (cached && typeof cached === 'object') {
        return cached as UpWorkPageBlueprint;
      }
    }
  } catch {
    // ignore storage error
  }

  return null;
}

export async function runSelectorAuditOnTab(
  deps: DiscoveryRpcDeps,
  tabId: number,
  opts: {
    view?: string;
    tabUrl?: string;
    updateBaseline?: boolean;
    selectorConfig?: SelectorConfig;
    isAuthenticated?: boolean;
  } = {},
): Promise<Record<string, unknown>> {
  const selectorConfig =
    opts.selectorConfig ?? (await deps.getSelectors().catch(() => BUNDLED_SELECTORS));
  const sendTab = deps.sendTabMessage ?? defaultSendTabMessage;
  const expectedViewType = inferAuditViewType(opts.view, opts.tabUrl);

  let existingBaseline = await fetchStoredBaseline(deps.proxyFetch, expectedViewType);

  const reply = (await sendTab(tabId, {
    type: 'CONTENT_AUDIT_SELECTORS',
    view: opts.view,
    selectorConfig,
    baseline: existingBaseline,
    isAuthenticated: opts.isAuthenticated,
    capturedXhrEndpoints: deps.getPassivePayloads?.().map((p) => p.url),
  })) as ContentAuditReply | undefined;

  if (!reply) {
    throw new BridgeRpcError('SELECTOR_BROKEN', 'Content script returned empty audit response');
  }

  if (!reply.ok && reply.errorCode === 'HUMAN_ACTION_REQUIRED') {
    throw new HumanActionRequiredError(
      reply.reason ?? 'Verification challenge detected during selector audit',
      reply.challengeType ?? 'unknown',
      reply.url ?? opts.tabUrl,
    );
  }

  if (!reply.ok || !reply.report || !reply.blueprint) {
    throw new BridgeRpcError('INTERNAL_ERROR', reply.reason ?? 'Selector audit failed');
  }

  const report = reply.report;
  const blueprint = reply.blueprint;
  const overallStatus = reply.overall_status ?? 'HEALTHY';

  if (!existingBaseline && report.view_type !== expectedViewType) {
    existingBaseline = await fetchStoredBaseline(deps.proxyFetch, report.view_type);
  }

  const baselineToPersist = opts.updateBaseline ? blueprint : (existingBaseline ?? blueprint);

  try {
    const currentCache = await selectorBaselinesItem.getValue().catch(() => ({}));
    await selectorBaselinesItem.setValue({
      ...(currentCache ?? {}),
      [report.view_type]: baselineToPersist,
    });
  } catch {
    // ignore storage cache write failure
  }

  let createdAudit: Record<string, unknown> | undefined;
  try {
    const persistRes = await deps.proxyFetch('/api/selector-audits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        view_type: report.view_type,
        overall_status: overallStatus,
        report,
        baseline: baselineToPersist,
      }),
    });
    if (persistRes.ok) {
      const json = (await persistRes.json()) as { audit?: Record<string, unknown> };
      createdAudit = json.audit;
    }
  } catch {
    // non-fatal if daemon audit persistence fails offline
  }

  deps.recordActivity?.({
    source: 'tab',
    action: 'audit.selectors',
    detail: `Audited ${report.view_type}: ${overallStatus}`,
    status: overallStatus === 'BROKEN' ? 'error' : overallStatus === 'HEALTHY' ? 'ok' : 'warn',
  });

  return {
    ok: true,
    audit: createdAudit,
    overall_status: overallStatus,
    report,
    blueprint,
  };
}

function resolveAuditTargetUrl(view?: string, explicitUrl?: string): string | null {
  if (explicitUrl && explicitUrl.trim()) {
    return explicitUrl.trim();
  }
  switch ((view ?? '').trim()) {
    case 'search_listings':
    case 'search_results':
    case '':
      return 'https://www.upwork.com/nx/search/jobs/?sort=recency';
    case 'best_matches':
      return 'https://www.upwork.com/nx/find-work/best-matches';
    case 'most_recent':
      return 'https://www.upwork.com/nx/find-work/most-recent';
    case 'saved_jobs':
      return 'https://www.upwork.com/nx/find-work/saved-jobs';
    case 'proposals_list':
      return 'https://www.upwork.com/nx/proposals/';
    case 'messages_rooms':
      return 'https://www.upwork.com/ab/messages/rooms';
    default:
      return null;
  }
}

export async function executeSelectorAuditRpc(
  deps: DiscoveryRpcDeps,
  params: Record<string, unknown>,
  sendProgress?: ProgressCallback,
  requestId = `audit-${Date.now()}`,
): Promise<Record<string, unknown>> {
  const view = typeof params.view === 'string' ? params.view : undefined;
  const explicitUrl = typeof params.url === 'string' ? params.url : undefined;
  const updateBaseline = params.update_baseline === true;
  const useActiveTab = params.use_active_tab === true;

  if (useActiveTab && !explicitUrl) {
    const activeTab = await findUpworkTab(
      deps,
      typeof params.tab_id === 'number' ? params.tab_id : undefined,
    );
    if (activeTab) {
      sendProgress?.('audit', 1, 2, 'Auditing active Upwork tab');
      const result = await runSelectorAuditOnTab(deps, activeTab.id, {
        view,
        tabUrl: activeTab.url,
        updateBaseline,
      });
      sendProgress?.('persist', 2, 2, 'Saved selector audit report');
      return result;
    }
  }

  const targetUrl = resolveAuditTargetUrl(view, explicitUrl);
  if (!targetUrl) {
    throw new BridgeRpcError(
      'INVALID_PARAMS',
      `Explicit url is required for auditing view "${view ?? 'unknown'}"`,
      -32602,
    );
  }

  const selectorConfig = await deps.getSelectors();
  const inferredView = inferAuditViewType(view, targetUrl);
  const configView =
    inferredView === 'messages'
      ? /\/ab\/messages\/rooms\/[^/?#]+/.test(targetUrl.toLowerCase())
        ? 'messages_thread'
        : 'messages_rooms'
      : inferredView === 'search_results'
        ? 'search_listings'
        : inferredView;
  const containerSelectors = selectorConfig.views[configView]?.container_selectors;
  const waitForSelectors =
    containerSelectors && containerSelectors.length > 0 ? containerSelectors : ['main'];

  return deps.tabController.runSerialized(requestId, async (signal) => {
    sendProgress?.('navigate', 1, 3, 'Opening target view for selector audit');
    const nav = await deps.tabController.navigateAndWaitForHydration(
      targetUrl,
      {
        guards: selectorConfig.auth_and_challenge_guards,
        waitForSelectors,
        timeoutMs: 3_500,
        allowSelectorTimeout: true,
      },
      signal,
    );
    sendProgress?.('audit', 2, 3, 'Auditing live DOM selectors');
    const result = await runSelectorAuditOnTab(deps, nav.tabId, {
      view,
      tabUrl: nav.url,
      updateBaseline,
      selectorConfig,
      isAuthenticated: nav.loggedIn,
    });
    sendProgress?.('persist', 3, 3, 'Saved selector audit report');
    return result;
  });
}

async function captureDiagnosticOnTab(
  deps: DiscoveryRpcDeps,
  tab: { id: number; url: string; windowId?: number },
  opts: {
    view?: string;
    scope: DiagnosticScope;
    includeScreenshot: boolean;
    redactPii: boolean;
    brokenFields: string[];
    selectorConfig: SelectorConfig;
    isAuthenticated?: boolean;
  },
): Promise<{ ok: true; capture: UiDiagnosticCapture }> {
  const sendTab = deps.sendTabMessage ?? defaultSendTabMessage;
  const expectedView = inferAuditViewType(opts.view, tab.url);
  const existingBaseline = await fetchStoredBaseline(deps.proxyFetch, expectedView);

  const reply = (await sendTab(tab.id, {
    type: 'CONTENT_CAPTURE_UI_DIAGNOSTIC',
    view: opts.view,
    scope: opts.scope,
    redactPii: opts.redactPii,
    brokenFields: opts.brokenFields,
    selectorConfig: opts.selectorConfig,
    baseline: existingBaseline,
    isAuthenticated: opts.isAuthenticated,
    passivePayloads: deps.getPassivePayloads?.() ?? [],
  })) as ContentCaptureDiagnosticReply | undefined;

  if (!reply) {
    throw new BridgeRpcError('INTERNAL_ERROR', 'Content script returned empty diagnostic capture');
  }
  if (!reply.ok && reply.errorCode === 'HUMAN_ACTION_REQUIRED') {
    throw new HumanActionRequiredError(
      reply.reason ?? 'Verification challenge detected during diagnostic capture',
      reply.challengeType ?? 'unknown',
      reply.url ?? tab.url,
    );
  }
  if (!reply.ok || !reply.capture) {
    throw new BridgeRpcError('INTERNAL_ERROR', reply.reason ?? 'Diagnostic capture failed');
  }

  const capture: UiDiagnosticCapture = { ...reply.capture };
  if (opts.includeScreenshot && tab.windowId !== undefined) {
    try {
      const capFn = deps.captureVisibleTab ?? defaultCaptureVisibleTab;
      const dataUrl = await capFn(tab.windowId);
      if (dataUrl) {
        capture.screenshot_data_url = dataUrl;
      }
    } catch {
      // Optional screenshot failed (e.g., unfocused/headless window); preserve DOM capture
    }
  }

  deps.recordActivity?.({
    source: 'tab',
    action: 'diagnostics.capture',
    detail: `Captured ${capture.view_type} (${capture.broken_fields.length} failing field(s))`,
    status: capture.overall_status === 'BROKEN' ? 'warn' : 'ok',
  });

  return { ok: true, capture };
}

export async function executeUiDiagnosticCaptureRpc(
  deps: DiscoveryRpcDeps,
  params: Record<string, unknown>,
  sendProgress?: ProgressCallback,
  requestId = `diag-capture-${Date.now()}`,
): Promise<Record<string, unknown>> {
  const view =
    typeof params.view === 'string' && params.view.trim() ? params.view.trim() : undefined;
  const explicitUrl =
    typeof params.url === 'string' && params.url.trim() ? params.url.trim() : undefined;
  const rawScope = typeof params.scope === 'string' ? params.scope.trim() : 'auto';
  const scope: DiagnosticScope = rawScope === 'drawer' || rawScope === 'page' ? rawScope : 'auto';
  const useActiveTab = params.use_active_tab !== false && !explicitUrl;
  const includeScreenshot = params.include_screenshot === true;
  const redactPii = params.redact_pii !== false;
  const brokenFields = Array.isArray(params.broken_fields)
    ? params.broken_fields.filter((s): s is string => typeof s === 'string')
    : [];
  const preferredTabId = typeof params.tab_id === 'number' ? params.tab_id : undefined;

  const selectorConfig = await deps.getSelectors(true).catch(() => BUNDLED_SELECTORS);

  if (useActiveTab || preferredTabId !== undefined) {
    const tab = await findUpworkTab(deps, preferredTabId);
    if (tab) {
      sendProgress?.('capture', 1, 2, 'Capturing live DOM diagnostic from active tab');
      const captured = await captureDiagnosticOnTab(deps, tab, {
        view,
        scope,
        includeScreenshot,
        redactPii,
        brokenFields,
        selectorConfig,
      });
      sendProgress?.('complete', 2, 2, 'UI diagnostic capture complete');
      return captured;
    }
  }

  const targetUrl = resolveAuditTargetUrl(view, explicitUrl);
  if (!targetUrl) {
    throw new BridgeRpcError(
      'TAB_NOT_FOUND',
      'No open Upwork tab found and no explicit URL/default view route could be resolved',
    );
  }

  const inferredView = inferAuditViewType(view, targetUrl);
  const configView =
    inferredView === 'messages'
      ? /\/ab\/messages\/rooms\/[^/?#]+/.test(targetUrl.toLowerCase())
        ? 'messages_thread'
        : 'messages_rooms'
      : inferredView === 'search_results'
        ? 'search_listings'
        : inferredView;
  const containerSelectors = selectorConfig.views[configView]?.container_selectors;
  const waitForSelectors =
    containerSelectors && containerSelectors.length > 0 ? containerSelectors : ['main'];

  return deps.tabController.runSerialized(requestId, async (signal) => {
    sendProgress?.('navigate', 1, 3, 'Opening target view for UI diagnostic capture');
    const nav = await deps.tabController.navigateAndWaitForHydration(
      targetUrl,
      {
        guards: selectorConfig.auth_and_challenge_guards,
        waitForSelectors,
        timeoutMs: 3_500,
        allowSelectorTimeout: true,
      },
      signal,
    );
    sendProgress?.('capture', 2, 3, 'Capturing pruned DOM and selector candidates');
    const allTabs = await (deps.queryTabs ?? defaultQueryTabs)({}).catch(() => []);
    const tabMeta = allTabs.find((t) => t.id === nav.tabId);
    const captured = await captureDiagnosticOnTab(
      deps,
      { id: nav.tabId, url: nav.url, windowId: tabMeta?.windowId },
      {
        view,
        scope,
        includeScreenshot,
        redactPii,
        brokenFields,
        selectorConfig,
        isAuthenticated: nav.loggedIn,
      },
    );
    sendProgress?.('complete', 3, 3, 'UI diagnostic capture complete');
    return captured;
  });
}

export async function executeSelectorPatchTestRpc(
  deps: DiscoveryRpcDeps,
  params: Record<string, unknown>,
  sendProgress?: ProgressCallback,
): Promise<Record<string, unknown>> {
  const view = typeof params.view === 'string' ? params.view.trim() : '';
  const field = typeof params.field === 'string' ? params.field.trim() : '';
  const prunedHtml =
    typeof params.pruned_html === 'string' && params.pruned_html.trim()
      ? params.pruned_html
      : undefined;
  const parsedRule = FieldSelectorRuleSchema.safeParse(params.rule);

  if (!view || !field || !parsedRule.success) {
    throw new BridgeRpcError(
      'INVALID_PARAMS',
      'view, field, and valid rule { selectors, extract } are required',
      -32602,
    );
  }
  const rule: FieldSelectorRule = parsedRule.data;
  const selectorConfig = await deps.getSelectors(true).catch(() => BUNDLED_SELECTORS);

  sendProgress?.('test', 1, 2, `Dry-running patch for ${view}.${field}`);

  if (prunedHtml && typeof DOMParser !== 'undefined') {
    const result: SelectorPatchTestResult = testSelectorPatchOnDocument(
      prunedHtml,
      selectorConfig,
      view,
      field,
      rule,
    );
    sendProgress?.('complete', 2, 2, 'Dry-run complete');
    return result as unknown as Record<string, unknown>;
  }

  const sendTab = deps.sendTabMessage ?? defaultSendTabMessage;
  const preferredTabId = typeof params.tab_id === 'number' ? params.tab_id : undefined;
  const tab = await findUpworkTab(deps, preferredTabId);
  if (!tab) {
    throw new BridgeRpcError(
      'TAB_NOT_FOUND',
      'Open an Upwork tab in Chrome to dry-run selector patches against the DOM',
    );
  }

  const reply = (await sendTab(tab.id, {
    type: 'CONTENT_TEST_SELECTOR_PATCH',
    view,
    field,
    rule,
    selectorConfig,
    ...(prunedHtml ? { prunedHtml } : {}),
  })) as SelectorPatchTestResult | undefined;

  if (!reply) {
    throw new BridgeRpcError('INTERNAL_ERROR', 'Content script returned empty patch test result');
  }

  sendProgress?.('complete', 2, 2, 'Dry-run complete');
  return reply as unknown as Record<string, unknown>;
}

export async function handleBgCaptureUiDiagnosticCommand(
  deps: DiscoveryRpcDeps,
  msg: {
    useActiveTab?: boolean;
    view?: string;
    url?: string;
    scope?: DiagnosticScope;
    includeScreenshot?: boolean;
    redactPii?: boolean;
    brokenFields?: string[];
  },
): Promise<Record<string, unknown>> {
  const captured = (await executeUiDiagnosticCaptureRpc(deps, {
    use_active_tab: msg.useActiveTab ?? true,
    view: msg.view,
    url: msg.url,
    scope: msg.scope ?? 'auto',
    include_screenshot: msg.includeScreenshot ?? false,
    redact_pii: msg.redactPii ?? true,
    broken_fields: msg.brokenFields ?? [],
  })) as { ok?: boolean; capture?: UiDiagnosticCapture };

  if (!captured.capture) {
    return { ok: false, error: 'Failed to capture UI diagnostic' };
  }

  try {
    const res = await deps.proxyFetch('/api/diagnostics/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(captured.capture),
    });
    if (res.ok) {
      const saved = (await res.json()) as Record<string, unknown>;
      return {
        ok: true,
        ...saved,
        capture: captured.capture,
      };
    }
    return {
      ok: true,
      capture: captured.capture,
      ingest_warning: `Daemon ingest returned HTTP ${res.status}`,
    };
  } catch (error) {
    return {
      ok: true,
      capture: captured.capture,
      ingest_warning: error instanceof Error ? error.message : 'Daemon offline',
    };
  }
}

export async function handleBgSelectorAuditCommand(
  deps: DiscoveryRpcDeps,
  msg: { view?: string; url?: string; updateBaseline?: boolean; useActiveTab?: boolean },
): Promise<Record<string, unknown>> {
  if (msg.url) {
    return executeSelectorAuditRpc(deps, {
      view: msg.view,
      url: msg.url,
      update_baseline: msg.updateBaseline,
    });
  }

  const queryTabs = deps.queryTabs ?? defaultQueryTabs;
  const activeTabs = await queryTabs({ active: true, currentWindow: true }).catch(() => []);
  const activeUpworkTab = activeTabs.find(
    (t) =>
      typeof t.id === 'number' &&
      typeof t.url === 'string' &&
      t.url.startsWith('https://www.upwork.com/'),
  );

  if (activeUpworkTab?.id !== undefined) {
    return runSelectorAuditOnTab(deps, activeUpworkTab.id, {
      view: msg.view,
      tabUrl: activeUpworkTab.url,
      updateBaseline: msg.updateBaseline,
    });
  }

  if (msg.view) {
    const targetUrl = resolveAuditTargetUrl(msg.view);
    if (targetUrl) {
      return executeSelectorAuditRpc(deps, {
        view: msg.view,
        url: targetUrl,
        update_baseline: msg.updateBaseline,
      });
    }
  }

  return {
    ok: false,
    error: 'Open an Upwork tab to audit the current view',
  };
}
