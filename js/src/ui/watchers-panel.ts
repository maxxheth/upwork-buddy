import { createWatchersApi, WatchersApiError } from '../api';
import type {
  ApiTransport,
  NotificationChannel,
  NotificationConfig,
  NotificationConfigUpdateRequest,
  NotificationTestResponse,
  TelegramChatCandidate,
  WatcherActionMode,
  WatcherDiscoveryBackend,
  WatcherDiscoveryConfig,
  WatchersStatusResponse,
  WatchEvent,
  WatchRule,
  WatchRuleCreateInput,
  WatchRun,
} from '../types';
import { escapeHtml } from '../utils';

export interface WatchersPanelOptions {
  onUnauthorized?: () => void;
  onStatusChange?: (status: WatchersStatusResponse) => void;
}

const NOTIFY_EVENT_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'hot_job_alert', label: 'Hot Job Alert' },
  { id: 'pending_approval', label: 'Pending Approval' },
  { id: 'proposal_submitted', label: 'Proposal Submitted' },
  { id: 'human_action_required', label: 'Human Action Required' },
  { id: 'watcher_paused', label: 'Watcher Paused' },
];

function parseCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseOptionalInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : null;
}

function parseOptionalFloat(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

function createEmptyRuleDraft(): WatchRuleCreateInput {
  return {
    name: '',
    description: '',
    enabled: false,
    discovery_backend: 'chrome',
    discovery_config: {
      source: 'search',
      queries: [],
      max_pages: 3,
      per_page: 20,
      contract_type: '',
      payment_verified_only: false,
      from_active_projects: false,
      scraper_fs_profile: '',
      scraper_fs_adapter: 'flaresolverr',
      scraper_fs_proxy_mode: 'rotation',
    },
    interval_minutes: 5,
    jitter_ratio: 0.35,
    active_hours: '',
    min_score: 75,
    max_proposals: null,
    max_posted_age_minutes: null,
    max_connects_per_job: null,
    require_payment_verified: true,
    required_keywords: [],
    exclude_keywords: [],
    action_mode: 'draft_and_fill',
    llm_model: '',
    llm_effort: '',
    bid_strategy: {
      hourly_rate: null,
      fixed_multiplier: null,
      min_fixed_bid: null,
      max_fixed_bid: null,
      rate_increase: '',
      boost_connects: null,
    },
    auto_submit_min_confidence: 0.85,
    fallback_on_screening_questions: true,
    max_reactions_per_tick: 2,
    seed_baseline_on_first_run: true,
  };
}

export class WatchersPanel {
  private readonly rootEl: HTMLElement;
  private readonly api: ReturnType<typeof createWatchersApi>;
  private readonly options: WatchersPanelOptions;

  private destroyed = false;
  private status: WatchersStatusResponse | null = null;
  private rules: WatchRule[] = [];
  private notifConfig: NotificationConfig | null = null;

  private bannerMessage = '';
  private bannerError = false;
  private testResult: NotificationTestResponse | null = null;

  private formOpen = false;
  private editingRuleId: number | null = null;
  private formBackend: WatcherDiscoveryBackend = 'chrome';

  private inspectedRuleId: number | null = null;
  private inspectedRuns: WatchRun[] = [];
  private inspectedEvents: WatchEvent[] = [];
  private inspectorLoading = false;
  private runningRuleIds = new Set<number>();

  private detectingTelegramChat = false;
  private detectedTelegramChats: TelegramChatCandidate[] = [];
  private detectedTelegramHint = '';
  private pendingTelegramToken = '';

  constructor(rootEl: HTMLElement, transport: ApiTransport, options: WatchersPanelOptions = {}) {
    this.rootEl = rootEl;
    this.api = createWatchersApi(transport, '');
    this.options = options;
  }

  async init(): Promise<void> {
    if (this.destroyed) return;
    await this.refreshAll();
  }

  destroy(): void {
    this.destroyed = true;
    this.rootEl.innerHTML = '';
  }

  async refreshAll(): Promise<void> {
    if (this.destroyed) return;
    try {
      const [statusRes, rulesRes, notifRes] = await Promise.all([
        this.api.getWatchersStatus(),
        this.api.listWatchers(),
        this.api.getNotificationConfig(),
      ]);
      if (this.destroyed) return;
      this.status = statusRes;
      this.rules = Array.isArray(rulesRes.rules) ? rulesRes.rules : [];
      this.notifConfig = notifRes.config ?? null;
      this.options.onStatusChange?.(statusRes);
    } catch (err) {
      if (this.handleAuthOrError(err, 'Failed to load watchers')) return;
    }
    if (!this.destroyed) {
      this.render();
    }
  }

  private handleAuthOrError(err: unknown, fallback: string): boolean {
    if (this.destroyed) return true;
    if (err instanceof WatchersApiError && err.status === 401) {
      this.options.onUnauthorized?.();
      return true;
    }
    this.bannerError = true;
    this.bannerMessage = err instanceof Error ? err.message : fallback;
    return false;
  }

  private setBanner(message: string, isError = false): void {
    this.bannerMessage = message;
    this.bannerError = isError;
  }

  private render(): void {
    if (this.destroyed) return;

    const status = this.status;
    const daemonRunning = Boolean(status?.running);
    const activeRules = status?.active_rules ?? this.rules.filter((r) => r.enabled && !r.paused_reason).length;
    const pausedRules = status?.paused_rules ?? this.rules.filter((r) => Boolean(r.paused_reason)).length;
    const activeReactions = status?.active_reactions ?? 0;
    const scraperFsAvailable = status?.scraper_fs_available ?? false;
    const scraperFsReason = status?.scraper_fs_reason ?? '';

    const bannerHtml = this.bannerMessage
      ? `<div class="dash-banner ${this.bannerError ? 'dash-banner-error' : 'dash-banner-success'}" data-testid="watchers-banner" role="status">${escapeHtml(this.bannerMessage)}</div>`
      : '';

    const formRule =
      this.editingRuleId !== null
        ? this.rules.find((r) => r.id === this.editingRuleId) ?? null
        : null;

    this.rootEl.innerHTML = `
      <div class="watchers-panel-inner">
        <div class="watchers-header">
          <div class="watchers-header-title">
            <strong>Automated Job Watchers</strong>
            <span class="dash-pill" data-testid="watchers-daemon-status" data-state="${daemonRunning ? 'connected' : 'disconnected'}">
              ${daemonRunning ? 'Daemon Running' : 'Daemon Stopped'}
            </span>
            <span class="dash-pill" data-testid="watchers-counts-pill">
              ${activeRules} active · ${pausedRules} paused · ${activeReactions} reacting
            </span>
            <span class="dash-pill" data-testid="watchers-scraper-fs-status" data-state="${scraperFsAvailable ? 'connected' : 'disconnected'}" title="${escapeHtml(scraperFsReason)}">
              scraper_fs: ${scraperFsAvailable ? 'Available' : `Unavailable${scraperFsReason ? ` (${escapeHtml(scraperFsReason)})` : ''}`}
            </span>
          </div>
          <div class="watchers-header-actions">
            <button type="button" class="dash-btn-primary" data-testid="new-watcher-btn">+ New Watch Rule</button>
            <button type="button" class="dash-btn-secondary" data-testid="refresh-watchers-btn">Refresh</button>
          </div>
        </div>

        ${bannerHtml}

        ${this.formOpen ? this.renderRuleForm(formRule) : ''}

        <div class="watchers-rules-section">
          <h4 class="watchers-section-title">Watch Rules (${this.rules.length})</h4>
          <div class="watchers-rules-list" data-testid="watchers-rules-list">
            ${this.rules.length === 0 ? '<p class="dash-muted">No watch rules configured yet. Create one to start automated discovery.</p>' : this.rules.map((r) => this.renderRuleCard(r)).join('')}
          </div>
        </div>

        ${this.inspectedRuleId !== null ? this.renderInspector() : ''}

        ${this.renderNotificationSettings()}
      </div>
    `;

    this.bindEvents();
  }

  private renderRuleCard(rule: WatchRule): string {
    const isPaused = Boolean(rule.paused_reason);
    const isRunning = this.runningRuleIds.has(rule.id);
    const statusLabel = isRunning
      ? 'Running...'
      : isPaused
        ? `Paused: ${rule.paused_reason}`
        : rule.enabled
          ? 'Active'
          : 'Disabled';
    const statusState = isRunning
      ? 'connected'
      : isPaused
        ? 'disconnected'
        : rule.enabled
          ? 'connected'
          : 'idle';
    const backendLabel = rule.discovery_backend === 'scraper_fs' ? 'scraper_fs' : 'Chrome';
    const rawQueries = Array.isArray(rule.discovery_config?.queries)
      ? rule.discovery_config.queries.join(', ')
      : rule.discovery_config?.query || '';
    const includesActiveProjects = Boolean(rule.discovery_config?.from_active_projects);
    const queries = rawQueries
      ? includesActiveProjects
        ? `${rawQueries} (+ active project tech stacks)`
        : rawQueries
      : includesActiveProjects
        ? 'Active project tech stacks'
        : '';
    const maxPages =
      rule.discovery_config?.max_pages && rule.discovery_config.max_pages > 0
        ? rule.discovery_config.max_pages
        : 1;
    const perPage = rule.discovery_config?.per_page;

    return `
      <article class="watcher-card" data-testid="watcher-rule-card" data-rule-id="${rule.id}">
        <div class="watcher-card-top">
          <div class="watcher-card-title-row">
            <strong>${escapeHtml(rule.name)}</strong>
            <span class="dash-pill" data-testid="watcher-rule-status" data-state="${statusState}">${escapeHtml(statusLabel)}</span>
            <span class="watcher-badge watcher-badge-backend" data-testid="watcher-backend-badge" data-backend="${escapeHtml(rule.discovery_backend)}">${escapeHtml(backendLabel)}</span>
            <span class="watcher-badge watcher-badge-action" data-testid="watcher-action-badge">${escapeHtml(rule.action_mode)}</span>
          </div>
          <div class="watcher-card-actions">
            <button type="button" class="dash-btn-sm js-watcher-toggle" data-testid="watcher-toggle-btn" data-id="${rule.id}">
              ${rule.enabled ? 'Disable' : 'Enable'}
            </button>
            <button type="button" class="dash-btn-sm dash-btn-accent js-watcher-run" data-testid="watcher-run-btn" data-id="${rule.id}" ${isRunning ? 'disabled' : ''}>
              ${isRunning ? 'Running...' : 'Run Now'}
            </button>
            <button type="button" class="dash-btn-sm js-watcher-dry-run" data-testid="watcher-dry-run-btn" data-id="${rule.id}" ${isRunning ? 'disabled' : ''}>
              Dry Run
            </button>
            ${
              isPaused
                ? `<button type="button" class="dash-btn-sm dash-btn-primary js-watcher-resume" data-testid="watcher-resume-btn" data-id="${rule.id}">Resume</button>`
                : ''
            }
            <button type="button" class="dash-btn-sm js-watcher-inspect" data-testid="watcher-inspect-btn" data-id="${rule.id}">
              Runs &amp; Events
            </button>
            <button type="button" class="dash-btn-sm js-watcher-edit" data-testid="watcher-edit-btn" data-id="${rule.id}">
              Edit
            </button>
            <button type="button" class="dash-btn-sm dash-btn-danger js-watcher-delete" data-testid="watcher-delete-btn" data-id="${rule.id}" ${isRunning ? 'disabled' : ''}>
              Delete
            </button>
          </div>
        </div>
        ${rule.description ? `<p class="watcher-card-desc">${escapeHtml(rule.description)}</p>` : ''}
        <div class="watcher-card-meta">
          <span>Every ${rule.interval_minutes}m (min score ${rule.min_score})</span>
          ${queries ? `<span>Queries: ${escapeHtml(queries)}</span>` : ''}
          <span>Pages: ${maxPages}${perPage ? ` (${perPage}/page)` : ''}</span>
          <span>Next: ${escapeHtml(rule.next_run_at || '—')}</span>
          <span>Last: ${escapeHtml(rule.last_run_at || 'Never')}</span>
          ${rule.last_error ? `<span class="watcher-error-text">Last error: ${escapeHtml(rule.last_error)}</span>` : ''}
        </div>
      </article>
    `;
  }

  private renderRuleForm(rule: WatchRule | null): string {
    const draft: WatchRuleCreateInput = rule
      ? {
          name: rule.name,
          description: rule.description,
          enabled: rule.enabled,
          discovery_backend: rule.discovery_backend,
          discovery_config: rule.discovery_config ?? {},
          interval_minutes: rule.interval_minutes,
          jitter_ratio: rule.jitter_ratio,
          active_hours: rule.active_hours,
          min_score: rule.min_score,
          max_proposals: rule.max_proposals ?? null,
          max_posted_age_minutes: rule.max_posted_age_minutes ?? null,
          max_connects_per_job: rule.max_connects_per_job ?? null,
          require_payment_verified: rule.require_payment_verified,
          required_keywords: rule.required_keywords ?? [],
          exclude_keywords: rule.exclude_keywords ?? [],
          action_mode: rule.action_mode,
          llm_model: rule.llm_model,
          llm_effort: rule.llm_effort,
          bid_strategy: rule.bid_strategy ?? {},
          auto_submit_min_confidence: rule.auto_submit_min_confidence,
          fallback_on_screening_questions: rule.fallback_on_screening_questions,
          max_reactions_per_tick: rule.max_reactions_per_tick,
          seed_baseline_on_first_run: rule.seed_baseline_on_first_run,
        }
      : createEmptyRuleDraft();

    const backend = this.formBackend;
    const dc = draft.discovery_config ?? {};
    const bs = draft.bid_strategy ?? {};
    const queriesStr = Array.isArray(dc.queries)
      ? dc.queries.join(', ')
      : dc.query ?? '';
    const scraperFsUnavailable = backend === 'scraper_fs' && this.status?.scraper_fs_available === false;

    return `
      <form id="watcher-rule-form" class="watcher-form" data-testid="watcher-rule-form">
        <div class="watcher-form-header">
          <strong>${rule ? `Edit Watch Rule: ${escapeHtml(rule.name)}` : 'Create Watch Rule'}</strong>
        </div>

        <div class="watcher-form-grid">
          <label>
            Rule Name *
            <input type="text" id="wf-name" data-testid="watcher-form-name" required value="${escapeHtml(draft.name)}" placeholder="e.g. Go + Postgres Hourly" />
          </label>
          <label class="dash-field-wide">
            Description
            <input type="text" id="wf-description" data-testid="watcher-form-description" value="${escapeHtml(draft.description ?? '')}" placeholder="Optional notes" />
          </label>
          <label class="dash-checkbox-inline">
            <input type="checkbox" id="wf-enabled" data-testid="watcher-form-enabled" ${draft.enabled === true ? 'checked' : ''} />
            Enabled
          </label>
        </div>

        <fieldset class="watcher-fieldset">
          <legend>Discovery Backend</legend>
          <div class="watcher-radio-row">
            <label class="dash-checkbox-inline">
              <input type="radio" name="wf-backend" value="chrome" data-testid="watcher-form-backend-chrome" ${backend === 'chrome' ? 'checked' : ''} />
              Chrome Extension (Live Session + GraphQL)
            </label>
            <label class="dash-checkbox-inline">
              <input type="radio" name="wf-backend" value="scraper_fs" data-testid="watcher-form-backend-scraper-fs" ${backend === 'scraper_fs' ? 'checked' : ''} />
              upwork-scraper-fs (FlareSolverr + Proxy Rotation)
            </label>
          </div>
          ${
            scraperFsUnavailable
              ? `<div class="dash-banner dash-banner-error" data-testid="watcher-scraper-fs-warning">upwork-scraper-fs is unavailable: ${escapeHtml(this.status?.scraper_fs_reason || 'not configured')}</div>`
              : ''
          }

          <div class="watcher-form-grid">
            <div data-testid="watcher-chrome-settings" ${backend !== 'chrome' ? 'hidden' : ''}>
              <label>
                Chrome Source
                <select id="wf-source" data-testid="watcher-form-source">
                  <option value="search" ${(dc.source ?? 'search') === 'search' ? 'selected' : ''}>search</option>
                  <option value="most_recent" ${dc.source === 'most_recent' ? 'selected' : ''}>most_recent</option>
                  <option value="best_matches" ${dc.source === 'best_matches' ? 'selected' : ''}>best_matches</option>
                  <option value="saved_jobs" ${dc.source === 'saved_jobs' ? 'selected' : ''}>saved_jobs</option>
                </select>
              </label>
            </div>

            <div class="watcher-subgrid" data-testid="watcher-scraper-fs-settings" ${backend !== 'scraper_fs' ? 'hidden' : ''}>
              <label>
                scraper_fs Profile
                <input type="text" id="wf-sfs-profile" data-testid="watcher-form-sfs-profile" value="${escapeHtml(dc.scraper_fs_profile ?? '')}" placeholder="default" />
              </label>
              <label>
                Proxy Mode
                <select id="wf-sfs-proxy-mode" data-testid="watcher-form-sfs-proxy-mode">
                  <option value="rotation" ${(dc.scraper_fs_proxy_mode ?? 'rotation') === 'rotation' ? 'selected' : ''}>rotation</option>
                  <option value="pinned" ${dc.scraper_fs_proxy_mode === 'pinned' ? 'selected' : ''}>pinned</option>
                  <option value="direct" ${dc.scraper_fs_proxy_mode === 'direct' ? 'selected' : ''}>direct</option>
                </select>
              </label>
              <label>
                Adapter
                <select id="wf-sfs-adapter" data-testid="watcher-form-sfs-adapter">
                  <option value="flaresolverr" ${(dc.scraper_fs_adapter ?? 'flaresolverr') === 'flaresolverr' ? 'selected' : ''}>flaresolverr</option>
                  <option value="stealthy_session" ${dc.scraper_fs_adapter === 'stealthy_session' ? 'selected' : ''}>stealthy_session</option>
                </select>
              </label>
            </div>

            <label class="dash-field-wide">
              Queries (comma-separated)
              <input type="text" id="wf-queries" data-testid="watcher-form-queries" value="${escapeHtml(queriesStr)}" placeholder="go postgresql, typescript playwright" />
            </label>
            <label>
              Max Pages (1–20)
              <input type="number" id="wf-max-pages" data-testid="watcher-form-max-pages" value="${dc.max_pages && dc.max_pages > 0 ? dc.max_pages : 1}" min="1" max="20" />
            </label>
            <label>
              Results / Page
              <select id="wf-per-page" data-testid="watcher-form-per-page">
                <option value="" ${!dc.per_page ? 'selected' : ''}>Default (10)</option>
                <option value="10" ${dc.per_page === 10 ? 'selected' : ''}>10</option>
                <option value="20" ${dc.per_page === 20 ? 'selected' : ''}>20</option>
                <option value="50" ${dc.per_page === 50 ? 'selected' : ''}>50</option>
              </select>
            </label>
            <label>
              Contract Type
              <select id="wf-contract-type" data-testid="watcher-form-contract-type">
                <option value="" ${!dc.contract_type ? 'selected' : ''}>Any</option>
                <option value="hourly" ${dc.contract_type === 'hourly' ? 'selected' : ''}>hourly</option>
                <option value="fixed" ${dc.contract_type === 'fixed' ? 'selected' : ''}>fixed</option>
              </select>
            </label>
            <label>
              Budget Min ($)
              <input type="number" id="wf-budget-min" data-testid="watcher-form-budget-min" value="${dc.budget_min ?? ''}" min="0" />
            </label>
            <label>
              Budget Max ($)
              <input type="number" id="wf-budget-max" data-testid="watcher-form-budget-max" value="${dc.budget_max ?? ''}" min="0" />
            </label>
            <label>
              Rate Min ($/hr)
              <input type="number" id="wf-rate-min" data-testid="watcher-form-rate-min" value="${dc.hourly_rate_min ?? ''}" min="0" />
            </label>
            <label>
              Rate Max ($/hr)
              <input type="number" id="wf-rate-max" data-testid="watcher-form-rate-max" value="${dc.hourly_rate_max ?? ''}" min="0" />
            </label>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="wf-disc-payment-verified" data-testid="watcher-form-discovery-payment-verified" ${dc.payment_verified_only ? 'checked' : ''} />
              Discovery: Payment Verified Only
            </label>
            <label class="dash-checkbox-inline dash-field-wide" title="When checked, Upwork Buddy appends up to 6 extra search queries derived from your active projects' tech stacks (e.g. Go, Python, TypeScript). Leave unchecked to search only your Queries — active-project scoring still runs automatically.">
              <input type="checkbox" id="wf-from-active-projects" data-testid="watcher-form-from-active-projects" ${dc.from_active_projects ? 'checked' : ''} />
              Also search Active Project tech stacks (+up to 6 extra queries)
            </label>
          </div>
          <div class="watcher-form-hint" data-testid="watcher-from-active-projects-hint" ${dc.from_active_projects ? '' : 'hidden'}>
            Heads up: this appends up to 6 extra Upwork searches derived from your active projects&apos; tech stacks (e.g. Go, TypeScript, Python) alongside your Queries. Leave unchecked to search only the Queries entered above (portfolio/active-project scoring still runs automatically).
          </div>
        </fieldset>

        <fieldset class="watcher-fieldset">
          <legend>Cadence &amp; Qualification Gates</legend>
          <div class="watcher-form-grid">
            <label>
              Interval (minutes)
              <input type="number" id="wf-interval" data-testid="watcher-form-interval" value="${draft.interval_minutes ?? 5}" min="1" />
            </label>
            <label>
              Jitter Ratio
              <input type="number" id="wf-jitter" data-testid="watcher-form-jitter" value="${draft.jitter_ratio ?? 0.35}" min="0" max="0.9" step="0.05" />
            </label>
            <label>
              Active Hours (HH:MM-HH:MM)
              <input type="text" id="wf-active-hours" data-testid="watcher-form-active-hours" value="${escapeHtml(draft.active_hours ?? '')}" placeholder="08:00-22:00" />
            </label>
            <label>
              Min Score
              <input type="number" id="wf-min-score" data-testid="watcher-form-min-score" value="${draft.min_score ?? 75}" min="0" max="100" />
            </label>
            <label>
              Max Proposals
              <input type="number" id="wf-max-proposals" data-testid="watcher-form-max-proposals" value="${draft.max_proposals ?? ''}" min="0" />
            </label>
            <label>
              Max Posted Age (min)
              <input type="number" id="wf-max-age" data-testid="watcher-form-max-age" value="${draft.max_posted_age_minutes ?? ''}" min="0" />
            </label>
            <label>
              Max Connects/Job
              <input type="number" id="wf-max-connects" data-testid="watcher-form-max-connects" value="${draft.max_connects_per_job ?? ''}" min="0" />
            </label>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="wf-require-payment-verified" data-testid="watcher-form-require-payment-verified" ${draft.require_payment_verified ? 'checked' : ''} />
              Require Payment Verified
            </label>
            <label>
              Required Keywords (comma-separated)
              <input type="text" id="wf-required-kw" data-testid="watcher-form-required-keywords" value="${escapeHtml((draft.required_keywords ?? []).join(', '))}" />
            </label>
            <label>
              Excluded Keywords (comma-separated)
              <input type="text" id="wf-exclude-kw" data-testid="watcher-form-exclude-keywords" value="${escapeHtml((draft.exclude_keywords ?? []).join(', '))}" />
            </label>
          </div>
        </fieldset>

        <fieldset class="watcher-fieldset">
          <legend>Action Mode &amp; Bid Strategy</legend>
          <div class="watcher-form-grid">
            <label>
              Action Mode
              <select id="wf-action-mode" data-testid="watcher-form-action-mode">
                <option value="alert_only" ${draft.action_mode === 'alert_only' ? 'selected' : ''}>alert_only</option>
                <option value="draft_and_fill" ${draft.action_mode === 'draft_and_fill' ? 'selected' : ''}>draft_and_fill</option>
                <option value="auto_submit" ${draft.action_mode === 'auto_submit' ? 'selected' : ''}>auto_submit</option>
              </select>
            </label>
            <label>
              Hourly Rate ($)
              <input type="number" id="wf-bid-hourly" data-testid="watcher-form-bid-hourly-rate" value="${bs.hourly_rate ?? ''}" min="0" step="1" />
            </label>
            <label>
              Fixed Multiplier
              <input type="number" id="wf-bid-multiplier" data-testid="watcher-form-bid-fixed-multiplier" value="${bs.fixed_multiplier ?? ''}" min="0" step="0.05" />
            </label>
            <label>
              Min Fixed Bid ($)
              <input type="number" id="wf-bid-min-fixed" data-testid="watcher-form-bid-min-fixed" value="${bs.min_fixed_bid ?? ''}" min="0" />
            </label>
            <label>
              Max Fixed Bid ($)
              <input type="number" id="wf-bid-max-fixed" data-testid="watcher-form-bid-max-fixed" value="${bs.max_fixed_bid ?? ''}" min="0" />
            </label>
            <label>
              Rate Increase
              <input type="text" id="wf-bid-rate-increase" data-testid="watcher-form-bid-rate-increase" value="${escapeHtml(bs.rate_increase ?? '')}" placeholder="e.g. 5% every 6 months" />
            </label>
            <label>
              Boost Connects
              <input type="number" id="wf-bid-boost" data-testid="watcher-form-bid-boost-connects" value="${bs.boost_connects ?? ''}" min="0" />
            </label>
            <label>
              Auto-Submit Min Confidence
              <input type="number" id="wf-auto-confidence" data-testid="watcher-form-auto-submit-confidence" value="${draft.auto_submit_min_confidence ?? 0.85}" min="0" max="1" step="0.05" />
            </label>
            <label>
              Max Reactions / Tick
              <input type="number" id="wf-max-reactions" data-testid="watcher-form-max-reactions" value="${draft.max_reactions_per_tick ?? 2}" min="1" />
            </label>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="wf-fallback-screening" data-testid="watcher-form-fallback-screening" ${draft.fallback_on_screening_questions !== false ? 'checked' : ''} />
              Fallback on Screening Questions
            </label>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="wf-seed-baseline" data-testid="watcher-form-seed-baseline" ${draft.seed_baseline_on_first_run !== false ? 'checked' : ''} />
              Seed Baseline on First Run
            </label>
          </div>
        </fieldset>

        <div class="watcher-form-actions">
          <button type="submit" class="dash-btn-primary" data-testid="watcher-form-save-btn">
            ${rule ? 'Save Changes' : 'Create Watch Rule'}
          </button>
          <button type="button" class="dash-btn-secondary" data-testid="watcher-form-cancel-btn">Cancel</button>
        </div>
      </form>
    `;
  }

  private renderInspector(): string {
    const rule = this.rules.find((r) => r.id === this.inspectedRuleId);
    const title = rule ? rule.name : `Rule #${this.inspectedRuleId}`;

    const runsHtml =
      this.inspectorLoading
        ? '<p class="dash-muted">Loading runs and events...</p>'
        : this.inspectedRuns.length === 0
          ? '<p class="dash-muted">No runs recorded yet.</p>'
          : `<ul class="watcher-inspector-list" data-testid="watcher-runs-list">
              ${this.inspectedRuns
                .map(
                  (run) => `
                  <li>
                    <strong>#${run.id}</strong> [${escapeHtml(run.status)}] (${escapeHtml(run.discovery_backend)} / ${escapeHtml(run.triggered_by)})
                    — scraped ${run.scraped_count}, new ${run.new_jobs_count}, qualified ${run.qualified_count},
                    drafted ${run.drafted_count}, filled ${run.filled_count}, submitted ${run.submitted_count}, alerted ${run.alerted_count}
                    <small>${escapeHtml(run.started_at)}</small>
                    ${run.error_message ? `<span class="watcher-error-text">${escapeHtml(run.error_message)}</span>` : ''}
                  </li>
                `,
                )
                .join('')}
            </ul>`;

    const eventsHtml =
      this.inspectorLoading
        ? ''
        : this.inspectedEvents.length === 0
          ? '<p class="dash-muted">No job events recorded yet.</p>'
          : `<ul class="watcher-inspector-list" data-testid="watcher-events-list">
              ${this.inspectedEvents
                .map(
                  (ev) => `
                  <li>
                    <strong>${escapeHtml(ev.job_title || ev.upwork_job_id || `Job #${ev.job_id}`)}</strong>
                    — stage: <code>${escapeHtml(ev.stage)}</code>
                    ${ev.confidence != null ? ` (conf ${ev.confidence.toFixed(2)})` : ''}
                    ${ev.decision_reason ? ` — ${escapeHtml(ev.decision_reason)}` : ''}
                    ${ev.error_message ? `<span class="watcher-error-text">${escapeHtml(ev.error_message)}</span>` : ''}
                  </li>
                `,
                )
                .join('')}
            </ul>`;

    return `
      <section class="watcher-inspector" data-testid="watcher-inspector">
        <div class="watcher-inspector-header">
          <strong>Runs &amp; Events: ${escapeHtml(title)}</strong>
          <button type="button" class="dash-btn-sm" data-testid="watcher-inspector-close-btn">Close</button>
        </div>
        <div class="watcher-inspector-cols">
          <div>
            <h5>Recent Runs (${this.inspectedRuns.length})</h5>
            ${runsHtml}
          </div>
          <div>
            <h5>Recent Events (${this.inspectedEvents.length})</h5>
            ${eventsHtml}
          </div>
        </div>
      </section>
    `;
  }

  private renderNotificationSettings(): string {
    const cfg = this.notifConfig;
    const selectedEvents = new Set(cfg?.notify_events ?? []);
    const webhookPlaceholder = cfg?.has_webhook_secret
      ? 'Configured (leave blank to keep)'
      : 'Optional HMAC secret';
    const telegramPlaceholder = cfg?.has_telegram_bot_token
      ? 'Configured (leave blank to keep)'
      : 'Bot token from @BotFather';

    const testResultHtml = this.testResult
      ? `<div class="dash-banner ${this.testResult.ok ? 'dash-banner-success' : 'dash-banner-error'}" data-testid="notif-test-result">
          Test ${this.testResult.ok ? 'succeeded' : 'failed'}:
          ${Object.entries(this.testResult.results ?? {})
            .map(([ch, res]) => {
              const succeeded = Boolean(res.sent ?? res.ok);
              return `${escapeHtml(ch)}: ${succeeded ? 'sent' : `failed (${escapeHtml(res.error ?? 'error')})`}`;
            })
            .join(' | ')}
        </div>`
      : '';

    return `
      <section class="watcher-notifications" data-testid="notifications-settings">
        <h4 class="watchers-section-title">Notification Channels</h4>
        <form id="watcher-notif-form" class="watcher-notif-form">
          <div class="watcher-form-grid">
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="notif-chrome" data-testid="notif-chrome-enabled" ${cfg?.chrome_notifications_enabled ? 'checked' : ''} />
              Chrome Desktop Notifications
            </label>

            <label class="dash-checkbox-inline">
              <input type="checkbox" id="notif-webhook" data-testid="notif-webhook-enabled" ${cfg?.webhook_enabled ? 'checked' : ''} />
              Webhook Enabled
            </label>
            <label class="dash-field-wide">
              Webhook URL
              <input type="text" id="notif-webhook-url" data-testid="notif-webhook-url" value="${escapeHtml(cfg?.webhook_url ?? '')}" placeholder="https://example.com/webhook" />
            </label>
            <label>
              Webhook Secret
              <input type="password" id="notif-webhook-secret" data-testid="notif-webhook-secret" autocomplete="new-password" value="" placeholder="${escapeHtml(webhookPlaceholder)}" />
            </label>
            ${
              cfg?.has_webhook_secret
                ? `<label class="dash-checkbox-inline">
                    <input type="checkbox" id="notif-clear-webhook-secret" data-testid="notif-clear-webhook-secret" />
                    Clear Webhook Secret
                  </label>`
                : ''
            }

            <label class="dash-checkbox-inline">
              <input type="checkbox" id="notif-telegram" data-testid="notif-telegram-enabled" ${cfg?.telegram_enabled ? 'checked' : ''} />
              Telegram Enabled
            </label>
            <label>
              Telegram Bot Token
              <input type="password" id="notif-telegram-token" data-testid="notif-telegram-token" autocomplete="new-password" value="" placeholder="${escapeHtml(telegramPlaceholder)}" />
            </label>
            <label>
              Telegram Chat ID
              <div class="watcher-inline-input-row">
                <input type="text" id="notif-telegram-chat-id" data-testid="notif-telegram-chat-id" value="${escapeHtml(cfg?.telegram_chat_id ?? '')}" placeholder="123456789" />
                <button type="button" class="dash-btn-sm" data-testid="notif-telegram-detect-btn" ${this.detectingTelegramChat ? 'disabled' : ''}>
                  ${this.detectingTelegramChat ? 'Detecting...' : 'Detect Chat ID'}
                </button>
              </div>
            </label>
            ${
              cfg?.has_telegram_bot_token
                ? `<label class="dash-checkbox-inline">
                    <input type="checkbox" id="notif-clear-telegram-token" data-testid="notif-clear-telegram-token" />
                    Clear Telegram Token
                  </label>`
                : ''
            }
          </div>

          ${
            this.detectedTelegramChats.length > 0
              ? `<div class="watcher-telegram-chats" data-testid="notif-telegram-chats">
                  <span class="watcher-events-label">Detected Telegram chats (click to use &amp; save):</span>
                  <div class="watcher-telegram-chat-list">
                    ${this.detectedTelegramChats
                      .map(
                        (chat) => `
                        <button type="button" class="dash-btn-sm js-select-telegram-chat" data-testid="notif-telegram-chat-option" data-chat-id="${escapeHtml(chat.chat_id)}" data-display-name="${escapeHtml(chat.display_name)}">
                          ${escapeHtml(chat.display_name)} (<code>${escapeHtml(chat.chat_id)}</code>)${chat.last_text ? ` — "${escapeHtml(chat.last_text)}"` : ''}
                        </button>
                      `,
                      )
                      .join('')}
                  </div>
                </div>`
              : this.detectedTelegramHint
                ? `<div class="watcher-form-hint" data-testid="notif-telegram-detect-hint">${escapeHtml(this.detectedTelegramHint)}</div>`
                : ''
          }

          <div class="watcher-notify-events">
            <span class="watcher-events-label">Notify on events:</span>
            ${NOTIFY_EVENT_OPTIONS.map(
              (ev) => `
              <label class="dash-checkbox-inline">
                <input type="checkbox" class="js-notif-event" value="${escapeHtml(ev.id)}" data-testid="notif-event-${escapeHtml(ev.id)}" ${selectedEvents.has(ev.id) ? 'checked' : ''} />
                ${escapeHtml(ev.label)}
              </label>
            `,
            ).join('')}
          </div>

          <div class="watcher-notif-actions">
            <button type="submit" class="dash-btn-primary" data-testid="notif-save-btn">Save Notification Settings</button>
            <select id="notif-test-channel" data-testid="notif-test-channel" aria-label="Test notification channel">
              <option value="all">All Channels</option>
              <option value="chrome">Chrome</option>
              <option value="webhook">Webhook</option>
              <option value="telegram">Telegram</option>
            </select>
            <button type="button" class="dash-btn-secondary" data-testid="notif-test-btn">Send Test Notification</button>
          </div>
          ${testResultHtml}
        </form>
      </section>
    `;
  }

  private bindEvents(): void {
    this.rootEl.querySelector('[data-testid="new-watcher-btn"]')?.addEventListener('click', () => {
      this.editingRuleId = null;
      this.formBackend = 'chrome';
      this.formOpen = true;
      this.render();
    });

    this.rootEl
      .querySelector('[data-testid="refresh-watchers-btn"]')
      ?.addEventListener('click', () => void this.refreshAll());

    this.rootEl
      .querySelectorAll<HTMLInputElement>('input[name="wf-backend"]')
      .forEach((radio) => {
        radio.addEventListener('change', () => {
          if (radio.checked) {
            this.formBackend = radio.value === 'scraper_fs' ? 'scraper_fs' : 'chrome';
            const chromeSection = this.rootEl.querySelector<HTMLElement>(
              '[data-testid="watcher-chrome-settings"]',
            );
            const sfsSection = this.rootEl.querySelector<HTMLElement>(
              '[data-testid="watcher-scraper-fs-settings"]',
            );
            if (chromeSection) chromeSection.hidden = this.formBackend !== 'chrome';
            if (sfsSection) sfsSection.hidden = this.formBackend !== 'scraper_fs';

            // Update scraper_fs warning visibility if needed
            const existingWarn = this.rootEl.querySelector('[data-testid="watcher-scraper-fs-warning"]');
            if (this.formBackend === 'scraper_fs' && this.status?.scraper_fs_available === false) {
              if (!existingWarn) {
                const warn = document.createElement('div');
                warn.className = 'dash-banner dash-banner-error';
                warn.dataset.testid = 'watcher-scraper-fs-warning';
                warn.textContent = `upwork-scraper-fs is unavailable: ${this.status?.scraper_fs_reason || 'not configured'}`;
                this.rootEl.querySelector('.watcher-radio-row')?.insertAdjacentElement('afterend', warn);
              }
            } else {
              existingWarn?.remove();
            }
          }
        });
      });

    this.rootEl
      .querySelector<HTMLInputElement>('#wf-from-active-projects')
      ?.addEventListener('change', (e) => {
        const cb = e.currentTarget as HTMLInputElement;
        const hint = this.rootEl.querySelector<HTMLElement>(
          '[data-testid="watcher-from-active-projects-hint"]',
        );
        if (hint) {
          hint.hidden = !cb.checked;
        }
      });

    this.rootEl
      .querySelector('[data-testid="watcher-form-cancel-btn"]')
      ?.addEventListener('click', () => {
        this.formOpen = false;
        this.editingRuleId = null;
        this.render();
      });

    this.rootEl
      .querySelector<HTMLFormElement>('#watcher-rule-form')
      ?.addEventListener('submit', (e) => {
        e.preventDefault();
        void this.handleSaveRule();
      });

    this.rootEl.querySelectorAll<HTMLButtonElement>('.js-watcher-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const rule = this.rules.find((r) => r.id === id);
        if (rule) void this.handleToggle(id, !rule.enabled);
      });
    });

    this.rootEl.querySelectorAll<HTMLButtonElement>('.js-watcher-run').forEach((btn) => {
      btn.addEventListener('click', () => void this.handleRun(Number(btn.dataset.id), false));
    });

    this.rootEl.querySelectorAll<HTMLButtonElement>('.js-watcher-dry-run').forEach((btn) => {
      btn.addEventListener('click', () => void this.handleRun(Number(btn.dataset.id), true));
    });

    this.rootEl.querySelectorAll<HTMLButtonElement>('.js-watcher-resume').forEach((btn) => {
      btn.addEventListener('click', () => void this.handleResume(Number(btn.dataset.id)));
    });

    this.rootEl.querySelectorAll<HTMLButtonElement>('.js-watcher-inspect').forEach((btn) => {
      btn.addEventListener('click', () => void this.handleInspect(Number(btn.dataset.id)));
    });

    this.rootEl.querySelectorAll<HTMLButtonElement>('.js-watcher-edit').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        const rule = this.rules.find((r) => r.id === id);
        if (rule) {
          this.editingRuleId = id;
          this.formBackend = rule.discovery_backend;
          this.formOpen = true;
          this.render();
        }
      });
    });

    this.rootEl.querySelectorAll<HTMLButtonElement>('.js-watcher-delete').forEach((btn) => {
      btn.addEventListener('click', () => void this.handleDelete(Number(btn.dataset.id)));
    });

    this.rootEl
      .querySelector('[data-testid="watcher-inspector-close-btn"]')
      ?.addEventListener('click', () => {
        this.inspectedRuleId = null;
        this.inspectedRuns = [];
        this.inspectedEvents = [];
        this.render();
      });

    this.rootEl
      .querySelector<HTMLFormElement>('#watcher-notif-form')
      ?.addEventListener('submit', (e) => {
        e.preventDefault();
        void this.handleSaveNotifications();
      });

    this.rootEl
      .querySelector('[data-testid="notif-test-btn"]')
      ?.addEventListener('click', () => void this.handleTestNotification());

    this.rootEl
      .querySelector('[data-testid="notif-telegram-detect-btn"]')
      ?.addEventListener('click', () => void this.handleDetectTelegramChat());

    this.rootEl
      .querySelectorAll<HTMLButtonElement>('.js-select-telegram-chat')
      .forEach((btn) => {
        btn.addEventListener('click', () => {
          const chatId = btn.dataset.chatId?.trim() ?? '';
          const displayName = btn.dataset.displayName?.trim() ?? chatId;
          if (chatId) {
            void this.handleSelectDetectedTelegramChat(chatId, displayName);
          }
        });
      });
  }

  private val(selector: string): string {
    return this.rootEl.querySelector<HTMLInputElement | HTMLSelectElement>(selector)?.value ?? '';
  }

  private checked(selector: string): boolean {
    return this.rootEl.querySelector<HTMLInputElement>(selector)?.checked ?? false;
  }

  private async handleSaveRule(): Promise<void> {
    const name = this.val('#wf-name').trim();
    if (!name) {
      this.setBanner('Rule name is required.', true);
      this.render();
      return;
    }

    const existingRule =
      this.editingRuleId !== null
        ? this.rules.find((r) => r.id === this.editingRuleId)
        : undefined;
    const rawMaxPages = parseOptionalInt(this.val('#wf-max-pages'));
    const maxPages = rawMaxPages !== null ? Math.min(20, Math.max(1, rawMaxPages)) : 1;
    const rawPerPage = parseOptionalInt(this.val('#wf-per-page'));
    const perPage =
      rawPerPage === 10 || rawPerPage === 20 || rawPerPage === 50 ? rawPerPage : undefined;

    const discoveryConfig: WatcherDiscoveryConfig = {
      ...(existingRule?.discovery_config ?? {}),
      source: this.val('#wf-source') || 'search',
      queries: parseCsv(this.val('#wf-queries')),
      max_pages: maxPages,
      contract_type: this.val('#wf-contract-type'),
      budget_min: parseOptionalInt(this.val('#wf-budget-min')),
      budget_max: parseOptionalInt(this.val('#wf-budget-max')),
      hourly_rate_min: parseOptionalFloat(this.val('#wf-rate-min')),
      hourly_rate_max: parseOptionalFloat(this.val('#wf-rate-max')),
      payment_verified_only: this.checked('#wf-disc-payment-verified'),
      from_active_projects: this.checked('#wf-from-active-projects'),
      scraper_fs_profile: this.val('#wf-sfs-profile').trim(),
      scraper_fs_proxy_mode: this.val('#wf-sfs-proxy-mode') || 'rotation',
      scraper_fs_adapter: this.val('#wf-sfs-adapter') || 'flaresolverr',
    };
    if (perPage !== undefined) {
      discoveryConfig.per_page = perPage;
    } else {
      delete discoveryConfig.per_page;
    }

    const payload: WatchRuleCreateInput = {
      name,
      description: this.val('#wf-description').trim(),
      enabled: this.checked('#wf-enabled'),
      discovery_backend: this.formBackend,
      discovery_config: discoveryConfig,
      interval_minutes: parseOptionalInt(this.val('#wf-interval')) ?? 5,
      jitter_ratio: parseOptionalFloat(this.val('#wf-jitter')) ?? 0.35,
      active_hours: this.val('#wf-active-hours').trim(),
      min_score: (() => {
        const parsed = parseOptionalFloat(this.val('#wf-min-score'));
        return parsed !== null ? Math.round(parsed) : 75;
      })(),
      max_proposals: parseOptionalInt(this.val('#wf-max-proposals')),
      max_posted_age_minutes: parseOptionalInt(this.val('#wf-max-age')),
      max_connects_per_job: parseOptionalInt(this.val('#wf-max-connects')),
      require_payment_verified: this.checked('#wf-require-payment-verified'),
      required_keywords: parseCsv(this.val('#wf-required-kw')),
      exclude_keywords: parseCsv(this.val('#wf-exclude-kw')),
      action_mode: (this.val('#wf-action-mode') || 'draft_and_fill') as WatcherActionMode,
      bid_strategy: {
        hourly_rate: parseOptionalFloat(this.val('#wf-bid-hourly')),
        fixed_multiplier: parseOptionalFloat(this.val('#wf-bid-multiplier')),
        min_fixed_bid: parseOptionalFloat(this.val('#wf-bid-min-fixed')),
        max_fixed_bid: parseOptionalFloat(this.val('#wf-bid-max-fixed')),
        rate_increase: this.val('#wf-bid-rate-increase').trim(),
        boost_connects: parseOptionalInt(this.val('#wf-bid-boost')),
      },
      auto_submit_min_confidence: parseOptionalFloat(this.val('#wf-auto-confidence')) ?? 0.85,
      fallback_on_screening_questions: this.checked('#wf-fallback-screening'),
      max_reactions_per_tick: parseOptionalInt(this.val('#wf-max-reactions')) ?? 2,
      seed_baseline_on_first_run: this.checked('#wf-seed-baseline'),
    };

    try {
      if (this.editingRuleId !== null) {
        await this.api.updateWatcher(this.editingRuleId, payload);
        this.setBanner(`Updated watch rule "${name}".`);
      } else {
        await this.api.createWatcher(payload);
        this.setBanner(`Created watch rule "${name}".`);
      }
      this.formOpen = false;
      this.editingRuleId = null;
      await this.refreshAll();
    } catch (err) {
      if (this.handleAuthOrError(err, 'Failed to save watch rule')) return;
      this.render();
    }
  }

  private async handleToggle(id: number, enabled: boolean): Promise<void> {
    try {
      await this.api.toggleWatcher(id, enabled);
      this.setBanner(`Rule #${id} ${enabled ? 'enabled' : 'disabled'}.`);
      await this.refreshAll();
    } catch (err) {
      if (this.handleAuthOrError(err, 'Failed to toggle rule')) return;
      this.render();
    }
  }

  private async handleResume(id: number): Promise<void> {
    try {
      await this.api.resumeWatcher(id);
      this.setBanner(`Rule #${id} resumed.`);
      await this.refreshAll();
    } catch (err) {
      if (this.handleAuthOrError(err, 'Failed to resume rule')) return;
      this.render();
    }
  }

  private async handleRun(id: number, dryRun: boolean): Promise<void> {
    if (this.runningRuleIds.has(id)) return;
    const rule = this.rules.find((r) => r.id === id);
    const ruleLabel = rule ? `"${rule.name}"` : `Rule #${id}`;

    this.runningRuleIds.add(id);
    this.setBanner(`Running ${dryRun ? 'dry run' : 'watcher'} for ${ruleLabel}...`);
    this.render();

    try {
      const res = await this.api.runWatcher(id, { dry_run: dryRun });
      if (this.destroyed) return;
      this.runningRuleIds.delete(id);
      const r = res.run;
      if (r.status === 'seeded') {
        this.setBanner(
          `Run #${r.id} (baseline seeded): scraped ${r.scraped_count} existing job(s) so only newly posted jobs trigger future runs. Click "Run Now" later or disable "Seed Baseline on First Run" to react immediately.`,
        );
      } else if (r.status === 'skipped_busy') {
        this.setBanner(
          `Run #${r.id} (skipped — tab busy): automation tab was busy and will retry on the next tick.`,
        );
      } else if (dryRun) {
        const eventsCount = Array.isArray(res.events) ? res.events.length : 0;
        this.setBanner(
          `Dry run (${r.status}): scraped ${r.scraped_count}, new ${r.new_jobs_count}, qualified ${r.qualified_count}, preview events ${eventsCount} (no jobs or proposals saved).`,
        );
      } else {
        this.setBanner(
          `Run #${r.id} (${r.status}): scraped ${r.scraped_count}, new ${r.new_jobs_count}, qualified ${r.qualified_count}, drafted ${r.drafted_count}, filled ${r.filled_count}, submitted ${r.submitted_count}, alerted ${r.alerted_count}.`,
        );
      }
      if (this.inspectedRuleId === id) {
        await this.handleInspect(id);
      } else {
        await this.refreshAll();
      }
    } catch (err) {
      this.runningRuleIds.delete(id);
      if (this.handleAuthOrError(err, 'Failed to trigger watcher run')) return;
      this.render();
    }
  }

  private async handleDelete(id: number): Promise<void> {
    try {
      await this.api.deleteWatcher(id);
      if (this.inspectedRuleId === id) {
        this.inspectedRuleId = null;
      }
      this.setBanner(`Deleted rule #${id}.`);
      await this.refreshAll();
    } catch (err) {
      if (this.handleAuthOrError(err, 'Failed to delete rule')) return;
      this.render();
    }
  }

  private async handleInspect(id: number): Promise<void> {
    this.inspectedRuleId = id;
    this.inspectorLoading = true;
    this.render();
    try {
      const [runsRes, eventsRes] = await Promise.all([
        this.api.listWatcherRuns(id, { limit: 20, offset: 0 }),
        this.api.listWatcherEvents(id, { limit: 50, offset: 0 }),
      ]);
      if (this.destroyed) return;
      this.inspectedRuns = Array.isArray(runsRes.runs) ? runsRes.runs : [];
      this.inspectedEvents = Array.isArray(eventsRes.events) ? eventsRes.events : [];
    } catch (err) {
      if (this.handleAuthOrError(err, 'Failed to load runs & events')) return;
    } finally {
      this.inspectorLoading = false;
      if (!this.destroyed) this.render();
    }
  }

  private async handleSaveNotifications(): Promise<void> {
    const notifyEvents = Array.from(
      this.rootEl.querySelectorAll<HTMLInputElement>('.js-notif-event'),
    )
      .filter((cb) => cb.checked)
      .map((cb) => cb.value);

    const payload: NotificationConfigUpdateRequest = {
      chrome_notifications_enabled: this.checked('#notif-chrome'),
      webhook_enabled: this.checked('#notif-webhook'),
      webhook_url: this.val('#notif-webhook-url').trim(),
      telegram_enabled: this.checked('#notif-telegram'),
      telegram_chat_id: this.val('#notif-telegram-chat-id').trim(),
      notify_events: notifyEvents,
    };

    const webhookSecret = this.val('#notif-webhook-secret').trim();
    if (webhookSecret) {
      payload.webhook_secret = webhookSecret;
    } else if (this.checked('#notif-clear-webhook-secret')) {
      payload.clear_webhook_secret = true;
    }

    const telegramToken = this.val('#notif-telegram-token').trim();
    if (telegramToken) {
      payload.telegram_bot_token = telegramToken;
    } else if (this.checked('#notif-clear-telegram-token')) {
      payload.clear_telegram_bot_token = true;
    }

    try {
      const res = await this.api.updateNotificationConfig(payload);
      if (this.destroyed) return;
      this.notifConfig = res.config;
      this.setBanner('Notification settings saved.');
      this.render();
    } catch (err) {
      if (this.handleAuthOrError(err, 'Failed to save notification settings')) return;
      this.render();
    }
  }

  private async handleTestNotification(): Promise<void> {
    const channel = (this.val('#notif-test-channel') || 'all') as NotificationChannel;
    try {
      const res = await this.api.testNotifications(channel);
      if (this.destroyed) return;
      this.testResult = res;
      this.render();
    } catch (err) {
      if (this.handleAuthOrError(err, 'Failed to send test notification')) return;
      this.render();
    }
  }

  private async handleDetectTelegramChat(): Promise<void> {
    if (this.detectingTelegramChat) return;
    const typedToken = this.val('#notif-telegram-token').trim();
    this.pendingTelegramToken = typedToken;
    this.detectingTelegramChat = true;
    this.detectedTelegramHint = '';
    this.setBanner('Querying Telegram bot updates to detect chat ID...');
    this.render();

    try {
      const res = await this.api.detectTelegramChat({
        ...(typedToken ? { telegram_bot_token: typedToken } : {}),
        auto_save: true,
      });
      if (this.destroyed) return;
      this.detectingTelegramChat = false;
      this.detectedTelegramChats = Array.isArray(res.chats) ? res.chats : [];
      this.detectedTelegramHint = res.hint ?? '';

      if (res.saved && res.config && this.detectedTelegramChats.length === 1) {
        this.notifConfig = res.config;
        this.pendingTelegramToken = '';
        const chat = this.detectedTelegramChats[0];
        this.setBanner(
          `Detected and saved Telegram chat: ${chat.display_name} (ID: ${chat.chat_id}). Click "Send Test Notification" to verify.`,
        );
      } else if (this.detectedTelegramChats.length > 1) {
        this.setBanner(
          `Found ${this.detectedTelegramChats.length} Telegram chats. Select the one you want to use below.`,
        );
      } else {
        this.setBanner(
          this.detectedTelegramHint ||
            'No recent messages found. Send /start to your bot in Telegram, then click Detect Chat ID again.',
          true,
        );
      }
      this.render();
    } catch (err) {
      this.detectingTelegramChat = false;
      if (this.handleAuthOrError(err, 'Failed to detect Telegram chat ID')) return;
      this.render();
    }
  }

  private async handleSelectDetectedTelegramChat(
    chatId: string,
    displayName: string,
  ): Promise<void> {
    const payload: NotificationConfigUpdateRequest = {
      telegram_chat_id: chatId,
      telegram_enabled: true,
    };
    const typedToken = this.val('#notif-telegram-token').trim() || this.pendingTelegramToken;
    if (typedToken) {
      payload.telegram_bot_token = typedToken;
    }
    try {
      const res = await this.api.updateNotificationConfig(payload);
      if (this.destroyed) return;
      this.notifConfig = res.config;
      this.pendingTelegramToken = '';
      this.setBanner(
        `Saved Telegram chat: ${displayName} (ID: ${chatId}). Click "Send Test Notification" to verify.`,
      );
      this.render();
    } catch (err) {
      if (this.handleAuthOrError(err, 'Failed to save selected Telegram chat ID')) return;
      this.render();
    }
  }
}
