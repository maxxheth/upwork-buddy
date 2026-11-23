import type {
  ActiveProjectEntry,
  ActiveProjectsListResponse,
  AnalyzeSavedJobResponse,
  ApiTransport,
  BatchEnrichRequest,
  EnrichmentBatchDetailResponse,
  EnrichmentBatchesListResponse,
  EnrichmentBatchSummary,
  EnrichmentConfig,
  EnrichmentMode,
  SavedJob,
  SavedJobsResponse,
  SaveProposalRequest,
  SearchRunSummary,
  SearchRunsListResponse,
  WatchersStatusResponse,
} from '../types';
import { escapeHtml } from '../utils';
import { JobInspectorDrawer } from './job-inspector-drawer';
import {
  getEffectiveEnrichmentState,
  getMatchedProjectBadges,
  isJobAiEnriched,
  JobsTable,
} from './jobs-table';
import { WatchersPanel } from './watchers-panel';

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function finiteNumberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function isUnauthorizedError(err: unknown): boolean {
  if (err instanceof ApiError && err.status === 401) {
    return true;
  }
  return err instanceof Error && /\b401\b|unauthorized/i.test(err.message);
}

export interface DashboardControllerOptions {
  root: HTMLElement;
  transport: ApiTransport;
  surface: 'extension' | 'web';
  getExtensionRuntimeStatus?: () => Promise<{ wsConnected?: boolean; policyMode?: string } | null>;
  onUnauthorized?: () => void;
}

const DEFAULT_ENRICHMENT_CONFIG: EnrichmentConfig = {
  max_batch_size: 25,
  default_mode: 'full',
  default_force: false,
  skip_detail_if_present: true,
  require_details: false,
  max_concurrency: 2,
  default_model: '',
  default_effort: '',
  confirm_threshold: 5,
  wait_timeout_seconds: 60,
  web_ui_enabled: true,
  web_session_ttl_minutes: 720,
};

export class DashboardController {
  private readonly root: HTMLElement;
  private readonly transport: ApiTransport;
  private readonly surface: 'extension' | 'web';
  private readonly getExtensionRuntimeStatus?: () => Promise<{
    wsConnected?: boolean;
    policyMode?: string;
  } | null>;
  private readonly onUnauthorized?: () => void;

  private config: EnrichmentConfig = { ...DEFAULT_ENRICHMENT_CONFIG };
  private allJobs: SavedJob[] = [];
  private searchRuns: SearchRunSummary[] = [];
  private activeProjects: ActiveProjectEntry[] = [];
  private trackedBatches = new Map<number, EnrichmentBatchDetailResponse>();
  private pinnedBatchId: number | null = null;
  private batchSeqById = new Map<number, number>();
  private cancelingBatchIds = new Set<number>();
  private pendingSessionResetIds = new Set<number>();
  private inFlightSingleEnrichIds = new Set<number>();
  private inFlightStartBatchCount = 0;
  private batchItemsExpanded = false;

  private selectedRunId = '';
  private filterQuery = '';
  private filterFit = '';
  private filterEnrichment = '';
  private filterContract = '';
  private filterMatchedProject = '';
  private filterMinScore = '';

  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isPollInFlight = false;
  private pollTokenCounter = 0;
  private batchStateSeq = 0;
  private loadJobsSeq = 0;
  private destroyed = false;

  // Partitioned DOM element references
  private wsPillEl!: HTMLElement;
  private projectsPillEl!: HTMLElement;
  private searchRunSelectEl!: HTMLSelectElement;
  private toggleSearchPanelBtn!: HTMLButtonElement;
  private searchPanelEl!: HTMLElement;
  private toggleWatchersPanelBtn!: HTMLButtonElement;
  private watchersBadgeEl!: HTMLElement;
  private watchersPanelEl!: HTMLElement;
  private errorBannerEl!: HTMLElement;
  private batchBannerEl!: HTMLElement;
  private filterQueryInput!: HTMLInputElement;
  private filterFitSelect!: HTMLSelectElement;
  private filterEnrichmentSelect!: HTMLSelectElement;
  private filterContractSelect!: HTMLSelectElement;
  private filterMatchedProjectSelect!: HTMLSelectElement;
  private filterMinScoreInput!: HTMLInputElement;
  private bulkBarEl!: HTMLElement;
  private bulkSummaryEl!: HTMLElement;
  private bulkModeSelect!: HTMLSelectElement;
  private bulkForceCheckbox!: HTMLInputElement;
  private bulkModelInput!: HTMLInputElement;
  private bulkEffortSelect!: HTMLSelectElement;
  private confirmModalEl!: HTMLElement;
  private confirmSummaryEl!: HTMLElement;

  private table!: JobsTable;
  private drawer!: JobInspectorDrawer;
  private watchersPanel: WatchersPanel | null = null;
  private watchersPanelInitialized = false;

  constructor(options: DashboardControllerOptions) {
    this.root = options.root;
    this.transport = options.transport;
    this.surface = options.surface;
    this.getExtensionRuntimeStatus = options.getExtensionRuntimeStatus;
    this.onUnauthorized = options.onUnauthorized;
  }

  async init(): Promise<void> {
    if (this.destroyed) return;
    this.readInitialUrlParams();
    this.mountSkeleton();
    this.bindStaticEvents();

    await Promise.all([
      this.loadRuntimeStatus(),
      this.loadEnrichmentConfig(),
      this.loadActiveProjects(),
      this.loadSearchRuns(),
      this.loadWatchersStatus(),
    ]);

    if (this.destroyed) return;
    this.applyInitialFilterControlValues();
    await Promise.all([this.loadJobs(), this.loadActiveBatches()]);
  }

  destroy(): void {
    this.destroyed = true;
    this.batchStateSeq += 1;
    this.loadJobsSeq += 1;
    this.isPollInFlight = false;
    this.pollTokenCounter += 1;
    this.cancelingBatchIds.clear();
    this.pendingSessionResetIds.clear();
    this.inFlightSingleEnrichIds.clear();
    this.stopBatchPolling();
    this.drawer?.destroy();
    this.watchersPanel?.destroy();
  }

  private readInitialUrlParams(): void {
    try {
      const params = new URLSearchParams(window.location.search);
      const run = params.get('run');
      const fit = params.get('fit');
      const q = params.get('q');
      const batch = params.get('batch');
      if (run && /^\d+$/.test(run)) {
        this.selectedRunId = run;
      }
      if (fit) {
        this.filterFit = fit;
      }
      if (q) {
        this.filterQuery = q;
      }
      if (batch && /^\d+$/.test(batch)) {
        const parsed = Number.parseInt(batch, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          this.pinnedBatchId = parsed;
        }
      }
    } catch {
      // ignore invalid URLSearchParams in synthetic environments
    }
  }

  private mountSkeleton(): void {
    this.root.innerHTML = `
      <div class="dash-shell">
        <header id="dash-topbar" class="dash-topbar">
          <div class="dash-topbar-left">
            <h1 class="dash-brand">Upwork Buddy</h1>
            <span class="dash-surface-badge">${this.surface === 'extension' ? 'Extension Tab' : 'Web Dashboard'}</span>
            <span id="dash-ws-pill" data-testid="ws-status-pill" class="dash-pill">Connecting...</span>
            <span id="dash-projects-pill" data-testid="active-projects-pill" class="dash-pill">0 active</span>
          </div>
          <div class="dash-topbar-right">
            <label class="dash-inline-label">
              Search Run:
              <select id="dash-search-run-select" data-testid="search-run-select">
                <option value="">All Runs</option>
              </select>
            </label>
            <button type="button" id="dash-toggle-watchers-btn" data-testid="toggle-watchers-panel-btn" class="dash-btn-secondary">
              Watchers <span id="dash-watchers-badge" data-testid="watchers-status-badge" class="dash-badge-count">0</span>
            </button>
            <button type="button" id="dash-toggle-search-btn" data-testid="toggle-search-panel-btn" class="dash-btn-secondary">
              Run New Search
            </button>
          </div>
        </header>

        <section id="dash-search-panel" data-testid="search-panel" class="dash-search-panel" hidden>
          <div class="dash-search-panel-header">
            <div class="dash-search-panel-title">
              <strong>Multi-Criteria Upwork Search</strong>
              <span class="dash-zero-llm-badge">0 LLM tokens</span>
            </div>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="dash-match-active-cb" data-testid="match-active-projects-checkbox" />
              Match Active Projects (tech stack only, NDA-safe)
            </label>
          </div>
          <form id="dash-search-form" class="dash-search-grid">
            <label class="dash-field-wide">
              Queries (comma or newline separated)
              <input type="text" id="dash-search-queries" data-testid="search-queries-input" placeholder="e.g. go postgresql, typescript playwright" />
            </label>
            <label>
              Source
              <select id="dash-search-source" data-testid="search-source-select">
                <option value="search">Search</option>
                <option value="best_matches">Best Matches</option>
                <option value="most_recent">Most Recent</option>
                <option value="saved_jobs">Saved Jobs</option>
              </select>
            </label>
            <label>
              Contract Type
              <select id="dash-search-contract" data-testid="search-contract-select">
                <option value="">Any</option>
                <option value="hourly">Hourly</option>
                <option value="fixed">Fixed</option>
              </select>
            </label>
            <label>
              Min Rate ($/hr)
              <input type="number" id="dash-search-rate-min" data-testid="search-rate-min" min="0" step="1" placeholder="70" />
            </label>
            <label>
              Max Rate ($/hr)
              <input type="number" id="dash-search-rate-max" data-testid="search-rate-max" min="0" step="1" placeholder="150" />
            </label>
            <label>
              Min Budget ($)
              <input type="number" id="dash-search-budget-min" data-testid="search-budget-min" min="0" step="50" placeholder="500" />
            </label>
            <label>
              Max Budget ($)
              <input type="number" id="dash-search-budget-max" data-testid="search-budget-max" min="0" step="50" placeholder="10000" />
            </label>
            <label>
              Max Pages
              <input type="number" id="dash-search-max-pages" data-testid="search-max-pages" min="1" max="20" value="1" />
            </label>
            <label>
              Run Label
              <input type="text" id="dash-search-run-label" data-testid="search-run-label" placeholder="optional label" />
            </label>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="dash-search-payment-verified" data-testid="search-payment-verified" />
              Payment Verified Only
            </label>
            <div class="dash-search-submit-wrap">
              <button type="submit" id="dash-run-search-submit" data-testid="run-search-submit-btn" class="dash-btn-primary">
                Run Search (0 LLM tokens)
              </button>
              <span id="dash-search-panel-status" class="dash-muted"></span>
            </div>
          </form>
        </section>

        <section id="dash-watchers-panel" data-testid="watchers-panel" class="dash-watchers-panel" hidden></section>

        <div id="dash-error-banner" class="dash-banner dash-banner-error" role="alert" hidden></div>
        <div id="dash-batch-banner" class="dash-batch-banner" hidden></div>

        <section id="dash-filter-bar" class="dash-filter-bar">
          <input type="search" id="dash-filter-query" data-testid="filter-query-input" placeholder="Search jobs by title, skills, description..." />
          <select id="dash-filter-fit" data-testid="filter-fit-select" aria-label="Filter by fit">
            <option value="">All Fits</option>
            <option value="hot">Hot</option>
            <option value="ready">Ready</option>
            <option value="review">Review</option>
            <option value="skip">Skip</option>
          </select>
          <select id="dash-filter-enrichment" data-testid="filter-enrichment-select" aria-label="Filter by enrichment state">
            <option value="">All Enrichment States</option>
            <option value="none">Unenriched</option>
            <option value="detail_only">Details Only</option>
            <option value="queued">Queued</option>
            <option value="scraping_details">Scraping Details</option>
            <option value="analyzing">Analyzing</option>
            <option value="completed">AI Enriched</option>
            <option value="failed">Failed</option>
          </select>
          <select id="dash-filter-contract" data-testid="filter-contract-select" aria-label="Filter by contract type">
            <option value="">All Types</option>
            <option value="hourly">Hourly</option>
            <option value="fixed">Fixed</option>
          </select>
          <select id="dash-filter-matched-project" data-testid="filter-matched-project-select" aria-label="Filter by matched project">
            <option value="">All Matched Projects</option>
          </select>
          <input type="number" id="dash-filter-min-score" data-testid="filter-min-score-input" min="0" max="100" placeholder="Min score" />
          <button type="button" id="dash-refresh-btn" data-testid="refresh-jobs-btn" class="dash-btn-secondary">Refresh</button>
        </section>

        <section id="dash-bulk-bar" data-testid="bulk-selection-bar" class="dash-bulk-bar" hidden>
          <div class="dash-bulk-left">
            <strong id="dash-bulk-summary" data-testid="bulk-selection-summary">0 selected</strong>
          </div>
          <div class="dash-bulk-controls">
            <label class="dash-inline-label">
              Mode:
              <select id="dash-bulk-mode" data-testid="bulk-mode-select">
                <option value="full">Full (Details + AI)</option>
                <option value="ai_only">AI Only</option>
                <option value="detail_only">Detail Only (0 LLM)</option>
              </select>
            </label>
            <label class="dash-checkbox-inline">
              <input type="checkbox" id="dash-bulk-force" data-testid="bulk-force-checkbox" />
              Force re-enrich
            </label>
            <input type="text" id="dash-bulk-model" data-testid="bulk-model-input" placeholder="Model override (optional)" />
            <select id="dash-bulk-effort" data-testid="bulk-effort-select" aria-label="Effort override">
              <option value="">Effort: Default</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
            </select>
            <button type="button" id="dash-enrich-selected-btn" data-testid="enrich-selected-btn" class="dash-btn-primary">
              Enrich Selected
            </button>
            <button type="button" id="dash-clear-selection-btn" data-testid="bulk-clear-selection-btn" class="dash-btn-secondary">
              Clear
            </button>
          </div>
        </section>

        <div id="dash-table-wrap" class="dash-table-wrap"></div>
        <div id="dash-pagination" class="dash-pagination"></div>
        <div id="dash-drawer" class="dash-drawer-root" hidden></div>

        <div id="dash-confirm-modal" class="dash-modal-overlay" hidden>
          <div class="dash-modal" role="dialog" aria-modal="true" aria-label="Confirm Batch Enrichment" data-testid="confirm-enrich-dialog">
            <h3>Confirm Batch AI Enrichment</h3>
            <p id="dash-confirm-summary"></p>
            <div class="dash-modal-actions">
              <button type="button" id="dash-confirm-cancel-btn" data-testid="confirm-enrich-cancel-btn" class="dash-btn-secondary">Cancel</button>
              <button type="button" id="dash-confirm-proceed-btn" data-testid="confirm-enrich-proceed-btn" class="dash-btn-primary">Confirm Enrich</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.wsPillEl = this.mustQuery('#dash-ws-pill');
    this.projectsPillEl = this.mustQuery('#dash-projects-pill');
    this.searchRunSelectEl = this.mustQuery<HTMLSelectElement>('#dash-search-run-select');
    this.toggleSearchPanelBtn = this.mustQuery<HTMLButtonElement>('#dash-toggle-search-btn');
    this.searchPanelEl = this.mustQuery('#dash-search-panel');
    this.toggleWatchersPanelBtn = this.mustQuery<HTMLButtonElement>('#dash-toggle-watchers-btn');
    this.watchersBadgeEl = this.mustQuery('#dash-watchers-badge');
    this.watchersPanelEl = this.mustQuery('#dash-watchers-panel');
    this.errorBannerEl = this.mustQuery('#dash-error-banner');
    this.batchBannerEl = this.mustQuery('#dash-batch-banner');
    this.filterQueryInput = this.mustQuery<HTMLInputElement>('#dash-filter-query');
    this.filterFitSelect = this.mustQuery<HTMLSelectElement>('#dash-filter-fit');
    this.filterEnrichmentSelect = this.mustQuery<HTMLSelectElement>('#dash-filter-enrichment');
    this.filterContractSelect = this.mustQuery<HTMLSelectElement>('#dash-filter-contract');
    this.filterMatchedProjectSelect = this.mustQuery<HTMLSelectElement>(
      '#dash-filter-matched-project',
    );
    this.filterMinScoreInput = this.mustQuery<HTMLInputElement>('#dash-filter-min-score');
    this.bulkBarEl = this.mustQuery('#dash-bulk-bar');
    this.bulkSummaryEl = this.mustQuery('#dash-bulk-summary');
    this.bulkModeSelect = this.mustQuery<HTMLSelectElement>('#dash-bulk-mode');
    this.bulkForceCheckbox = this.mustQuery<HTMLInputElement>('#dash-bulk-force');
    this.bulkModelInput = this.mustQuery<HTMLInputElement>('#dash-bulk-model');
    this.bulkEffortSelect = this.mustQuery<HTMLSelectElement>('#dash-bulk-effort');
    this.confirmModalEl = this.mustQuery('#dash-confirm-modal');
    this.confirmSummaryEl = this.mustQuery('#dash-confirm-summary');

    this.table = new JobsTable({
      tableWrap: this.mustQuery('#dash-table-wrap'),
      paginationWrap: this.mustQuery('#dash-pagination'),
      callbacks: {
        onInspectJob: (job) => this.drawer.open(job),
        onEnrichSingleJob: (job) => {
          void this.handleSingleJobEnrich(job);
        },
        onStatusChange: (jobId, status) => {
          void this.handleStatusChange(jobId, status);
        },
        onSelectionChange: () => {
          this.updateBulkSelectionBar();
        },
      },
    });

    this.drawer = new JobInspectorDrawer({
      container: this.mustQuery('#dash-drawer'),
      callbacks: {
        onEnrichJob: (job) => this.enrichJobFromDrawer(job),
        onSaveProposalDraft: (job) => this.saveProposalDraftFromDrawer(job),
      },
    });
  }

  private mustQuery<T extends HTMLElement = HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) {
      throw new Error(`Dashboard skeleton missing ${selector}`);
    }
    return el;
  }

  private applyInitialFilterControlValues(): void {
    this.filterQueryInput.value = this.filterQuery;
    this.filterFitSelect.value = this.filterFit;
    this.filterEnrichmentSelect.value = this.filterEnrichment;
    this.filterContractSelect.value = this.filterContract;
    this.filterMatchedProjectSelect.value = this.filterMatchedProject;
    this.filterMinScoreInput.value = this.filterMinScore;
    if (this.selectedRunId) {
      this.searchRunSelectEl.value = this.selectedRunId;
    }
  }

  private bindStaticEvents(): void {
    this.toggleSearchPanelBtn.addEventListener('click', () => {
      this.searchPanelEl.hidden = !this.searchPanelEl.hidden;
    });

    this.toggleWatchersPanelBtn.addEventListener('click', () => {
      const willOpen = this.watchersPanelEl.hidden;
      this.watchersPanelEl.hidden = !willOpen;
      if (willOpen) {
        void this.ensureWatchersPanelInit();
      }
    });

    this.searchRunSelectEl.addEventListener('change', () => {
      this.selectedRunId = this.searchRunSelectEl.value;
      void this.loadJobs();
    });

    const searchForm = this.mustQuery<HTMLFormElement>('#dash-search-form');
    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.handleRunSearchSubmit();
    });

    this.filterQueryInput.addEventListener('input', () => {
      this.filterQuery = this.filterQueryInput.value;
      this.applyClientFilters();
    });

    this.filterFitSelect.addEventListener('change', () => {
      this.filterFit = this.filterFitSelect.value;
      this.applyClientFilters();
    });

    this.filterEnrichmentSelect.addEventListener('change', () => {
      this.filterEnrichment = this.filterEnrichmentSelect.value;
      this.applyClientFilters();
    });

    this.filterContractSelect.addEventListener('change', () => {
      this.filterContract = this.filterContractSelect.value;
      this.applyClientFilters();
    });

    this.filterMatchedProjectSelect.addEventListener('change', () => {
      this.filterMatchedProject = this.filterMatchedProjectSelect.value;
      this.applyClientFilters();
    });

    this.filterMinScoreInput.addEventListener('input', () => {
      this.filterMinScore = this.filterMinScoreInput.value;
      this.applyClientFilters();
    });

    this.mustQuery('#dash-refresh-btn').addEventListener('click', () => {
      void Promise.all([
        this.loadSearchRuns(),
        this.loadActiveProjects(),
        this.loadJobs(),
        this.loadActiveBatches(),
      ]);
    });

    this.bulkModeSelect.addEventListener('change', () => this.updateBulkSelectionBar());
    this.bulkForceCheckbox.addEventListener('change', () => this.updateBulkSelectionBar());

    this.mustQuery('#dash-clear-selection-btn').addEventListener('click', () => {
      this.table.clearSelection();
    });

    this.mustQuery('#dash-enrich-selected-btn').addEventListener('click', () => {
      this.handleBulkEnrichClick();
    });

    this.mustQuery('#dash-confirm-cancel-btn').addEventListener('click', () => {
      this.confirmModalEl.hidden = true;
    });

    this.mustQuery('#dash-confirm-proceed-btn').addEventListener('click', () => {
      this.confirmModalEl.hidden = true;
      void this.executeBulkEnrich();
    });

    this.batchBannerEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-testid="cancel-batch-btn"]')) {
        void this.cancelActiveBatches();
        return;
      }
      if (target.closest('[data-testid="batch-items-toggle"]')) {
        this.batchItemsExpanded = !this.batchItemsExpanded;
        this.renderBatchBanner();
        return;
      }
      if (target.closest('[data-testid="dismiss-batch-banner-btn"]')) {
        this.trackedBatches.clear();
        this.pinnedBatchId = null;
        this.cancelingBatchIds.clear();
        this.pendingSessionResetIds.clear();
        this.batchStateSeq += 1;
        this.batchItemsExpanded = false;
        this.renderBatchBanner();
      }
    });
  }

  private async requestJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.transport(path, init);
    if (this.destroyed) {
      throw new Error('Dashboard destroyed');
    }
    if (res.status === 401) {
      this.stopBatchPolling();
      this.onUnauthorized?.();
      throw new ApiError(401, 'Unauthorized (401)');
    }
    const text = await res.text();
    if (this.destroyed) {
      throw new Error('Dashboard destroyed');
    }
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }
    }
    if (!res.ok) {
      const errObj = parsed as { error?: string; message?: string };
      throw new ApiError(
        res.status,
        errObj.error || errObj.message || `Request failed (${res.status})`,
      );
    }
    return parsed as T;
  }

  private showError(message: string): void {
    this.errorBannerEl.textContent = message;
    this.errorBannerEl.hidden = !message;
  }

  private clearError(): void {
    this.errorBannerEl.textContent = '';
    this.errorBannerEl.hidden = true;
  }

  private async loadWatchersStatus(): Promise<void> {
    if (this.destroyed) return;
    try {
      const status = await this.requestJson<WatchersStatusResponse>('/api/watchers/status', {
        method: 'GET',
      });
      if (this.destroyed) return;
      this.updateWatchersBadge(status);
    } catch (err) {
      if (isUnauthorizedError(err)) return;
    }
  }

  private updateWatchersBadge(status: WatchersStatusResponse): void {
    if (typeof status?.active_rules !== 'number') return;
    const paused = typeof status.paused_rules === 'number' ? status.paused_rules : 0;
    this.watchersBadgeEl.textContent =
      paused > 0 ? `${status.active_rules} (${paused} paused)` : String(status.active_rules);
    this.watchersBadgeEl.dataset.state = paused > 0 ? 'paused' : status.active_rules > 0 ? 'active' : 'idle';
  }

  private async ensureWatchersPanelInit(): Promise<void> {
    if (this.destroyed || this.watchersPanelInitialized) return;
    this.watchersPanelInitialized = true;
    this.watchersPanel = new WatchersPanel(this.watchersPanelEl, this.transport, {
      onUnauthorized: () => {
        this.stopBatchPolling();
        this.onUnauthorized?.();
      },
      onStatusChange: (status) => {
        this.updateWatchersBadge(status);
      },
    });
    await this.watchersPanel.init();
  }

  private async loadRuntimeStatus(): Promise<void> {
    if (this.destroyed) return;
    if (this.surface === 'web') {
      try {
        const res = await this.transport('/api/health', { method: 'GET' });
        if (this.destroyed) return;
        this.wsPillEl.textContent = res.ok ? 'Daemon Connected' : 'Daemon Offline';
        this.wsPillEl.dataset.state = res.ok ? 'connected' : 'disconnected';
      } catch {
        if (this.destroyed) return;
        this.wsPillEl.textContent = 'Daemon Offline';
        this.wsPillEl.dataset.state = 'disconnected';
      }
      return;
    }

    if (!this.getExtensionRuntimeStatus) {
      this.wsPillEl.textContent = 'Extension Ready';
      this.wsPillEl.dataset.state = 'connected';
      return;
    }

    try {
      const status = await this.getExtensionRuntimeStatus();
      if (this.destroyed) return;
      const connected = Boolean(status?.wsConnected);
      this.wsPillEl.textContent = connected ? 'WS Connected' : 'WS Offline';
      this.wsPillEl.dataset.state = connected ? 'connected' : 'disconnected';
    } catch {
      if (this.destroyed) return;
      this.wsPillEl.textContent = 'WS Offline';
      this.wsPillEl.dataset.state = 'disconnected';
    }
  }

  private async loadEnrichmentConfig(): Promise<void> {
    if (this.destroyed) return;
    try {
      const cfg = await this.requestJson<EnrichmentConfig>('/api/enrichment-config', {
        method: 'GET',
      });
      if (this.destroyed) return;
      this.config = cfg;
      this.bulkModeSelect.value = cfg.default_mode || 'full';
      this.bulkForceCheckbox.checked = Boolean(cfg.default_force);
      this.bulkModelInput.value = cfg.default_model || '';
      this.bulkEffortSelect.value = cfg.default_effort || '';
      this.updateBulkSelectionBar();
    } catch {
      // Keep safe fallback defaults
    }
  }

  private async loadActiveProjects(): Promise<void> {
    if (this.destroyed) return;
    try {
      const data = await this.requestJson<ActiveProjectsListResponse>(
        '/api/active-projects?limit=500',
        {
          method: 'GET',
        },
      );
      if (this.destroyed) return;
      this.activeProjects = Array.isArray(data.projects) ? data.projects : [];
      const activeCount = this.activeProjects.filter((p) => p.activity_tier === 'active').length;
      const recentCount = this.activeProjects.filter((p) => p.activity_tier === 'recent').length;
      this.projectsPillEl.textContent = `${activeCount} active · ${recentCount} recent`;

      const anonymizedLabels = new Set<string>();
      for (const proj of this.activeProjects) {
        if (proj.proposal_visibility === 'anonymized') {
          if (proj.public_alias) anonymizedLabels.add(proj.public_alias);
          if (proj.name) anonymizedLabels.add(proj.name);
        }
      }
      this.table.setAnonymizedProjectLabels(anonymizedLabels);
      this.rebuildMatchedProjectFilterOptions();
    } catch {
      if (this.destroyed) return;
      this.projectsPillEl.textContent = '0 active';
    }
  }

  private rebuildMatchedProjectFilterOptions(): void {
    const labels = new Set<string>();
    for (const p of this.activeProjects) {
      if (p.proposal_visibility === 'private') continue;
      const display =
        p.proposal_visibility === 'anonymized'
          ? p.public_alias || p.project_key
          : p.public_alias || p.name || p.project_key;
      if (display) labels.add(display);
    }
    for (const job of this.allJobs) {
      for (const badge of getMatchedProjectBadges(job)) {
        labels.add(badge.label);
      }
    }
    const prev = this.filterMatchedProject;
    this.filterMatchedProjectSelect.innerHTML = `<option value="">All Matched Projects</option>${Array.from(
      labels,
    )
      .sort()
      .map((label) => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`)
      .join('')}`;
    this.filterMatchedProjectSelect.value = labels.has(prev) ? prev : '';
    this.filterMatchedProject = this.filterMatchedProjectSelect.value;
  }

  private async loadSearchRuns(): Promise<void> {
    if (this.destroyed) return;
    try {
      const data = await this.requestJson<SearchRunsListResponse>('/api/search-runs?limit=50', {
        method: 'GET',
      });
      if (this.destroyed) return;
      this.searchRuns = Array.isArray(data.search_runs) ? data.search_runs : [];
      const optionsHtml = this.searchRuns
        .map((run) => {
          const runId = finiteNumberOr(run.id, 0);
          const persistedCount = finiteNumberOr(run.persisted_count, 0);
          const safeRunId = escapeHtml(String(runId));
          const safePersistedCount = escapeHtml(String(persistedCount));
          const queriesText = Array.isArray(run.queries) ? run.queries.join(', ') : '';
          const title = String(run.label || queriesText || run.source || '');
          return `<option value="${safeRunId}">#${safeRunId} · ${escapeHtml(title)} (${safePersistedCount})</option>`;
        })
        .join('');
      this.searchRunSelectEl.innerHTML = `<option value="">All Runs</option>${optionsHtml}`;
      if (this.selectedRunId) {
        this.searchRunSelectEl.value = this.selectedRunId;
      }
    } catch {
      // ignore if runs fail transiently
    }
  }

  async loadJobs(): Promise<void> {
    if (this.destroyed) return;
    const seq = ++this.loadJobsSeq;
    try {
      const params = new URLSearchParams();
      params.set('limit', '500');
      if (this.selectedRunId) {
        params.set('search_run_id', this.selectedRunId);
      }
      const data = await this.requestJson<SavedJobsResponse>(`/api/jobs?${params.toString()}`, {
        method: 'GET',
      });
      if (this.destroyed || seq !== this.loadJobsSeq) return;
      this.clearError();
      this.allJobs = Array.isArray(data.jobs) ? data.jobs : [];
      this.rebuildMatchedProjectFilterOptions();
      this.applyClientFilters();

      const openId = this.drawer.getCurrentJobId();
      if (openId !== null) {
        const updatedOpen = this.allJobs.find((j) => j.id === openId);
        if (updatedOpen) {
          this.drawer.updateJobIfOpen(updatedOpen);
        }
      }
    } catch (err) {
      if (this.destroyed || seq !== this.loadJobsSeq) return;
      this.showError(err instanceof Error ? err.message : 'Failed to load jobs');
    }
  }

  private applyClientFilters(): void {
    const minScore = Number.parseFloat(this.filterMinScore);
    const hasMinScore = this.filterMinScore.trim() !== '' && Number.isFinite(minScore);
    const fitTarget = this.filterFit.trim().toLowerCase();
    const enrichTarget = this.filterEnrichment.trim().toLowerCase();
    const contractTarget = this.filterContract.trim().toLowerCase();
    const projectTarget = this.filterMatchedProject.trim().toLowerCase();

    const filtered = this.allJobs.filter((job) => {
      if (fitTarget && (job.fit_label ?? '').toLowerCase() !== fitTarget) {
        return false;
      }
      if (contractTarget && (job.contract_type ?? '').toLowerCase() !== contractTarget) {
        return false;
      }
      if (hasMinScore && (job.score ?? -1) < minScore) {
        return false;
      }
      if (enrichTarget && getEffectiveEnrichmentState(job).key !== enrichTarget) {
        return false;
      }
      if (projectTarget) {
        const badges = getMatchedProjectBadges(job);
        if (!badges.some((b) => b.label.toLowerCase() === projectTarget)) {
          return false;
        }
      }
      return true;
    });

    this.table.setJobs(filtered);
    this.table.setGlobalFilter(this.filterQuery);
    this.updateBulkSelectionBar();
  }

  private updateBulkSelectionBar(): void {
    const selected = this.table.getSelectedJobs();
    if (selected.length === 0) {
      this.bulkBarEl.hidden = true;
      return;
    }

    this.bulkBarEl.hidden = false;
    const mode = (this.bulkModeSelect.value || 'full') as EnrichmentMode;
    const force = this.bulkForceCheckbox.checked;
    const alreadyEnrichedCount = selected.filter(isJobAiEnriched).length;
    const willRunCount =
      mode === 'detail_only'
        ? selected.length
        : force
          ? selected.length
          : selected.length - alreadyEnrichedCount;

    this.bulkSummaryEl.textContent = `${selected.length} selected (${alreadyEnrichedCount} already AI-enriched; ${willRunCount} will run)`;
  }

  private handleBulkEnrichClick(): void {
    const selected = this.table.getSelectedJobs();
    if (selected.length === 0) return;

    const mode = (this.bulkModeSelect.value || 'full') as EnrichmentMode;
    const force = this.bulkForceCheckbox.checked;
    const alreadyEnrichedCount = selected.filter(isJobAiEnriched).length;
    const willRunCount =
      mode === 'detail_only'
        ? selected.length
        : force
          ? selected.length
          : selected.length - alreadyEnrichedCount;

    const needsConfirm =
      mode !== 'detail_only' &&
      (willRunCount > this.config.confirm_threshold ||
        (willRunCount > 0 && this.config.confirm_threshold === 0));

    if (needsConfirm) {
      const model = this.bulkModelInput.value.trim() || this.config.default_model || '(default)';
      const effort = this.bulkEffortSelect.value || this.config.default_effort || '(default)';
      this.confirmSummaryEl.textContent = `Run ${mode} enrichment for ${willRunCount} job(s) (${alreadyEnrichedCount} already enriched${force ? ', force=true' : ' will be skipped'})? Model: ${model} · Effort: ${effort}`;
      this.confirmModalEl.hidden = false;
      return;
    }

    void this.executeBulkEnrich();
  }

  private async executeBulkEnrich(): Promise<void> {
    const ids = this.table.getSelectedJobIds();
    if (ids.length === 0) return;
    const mode = (this.bulkModeSelect.value || 'full') as EnrichmentMode;
    const force = this.bulkForceCheckbox.checked;
    const model = this.bulkModelInput.value.trim();
    const effort = this.bulkEffortSelect.value;

    await this.startBatchEnrich(ids, {
      mode,
      force,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
  }

  private async handleSingleJobEnrich(job: SavedJob): Promise<void> {
    if (this.destroyed || this.inFlightSingleEnrichIds.has(job.id)) return;
    this.inFlightSingleEnrichIds.add(job.id);
    try {
      await this.startBatchEnrich([job.id], {
        mode: this.config.default_mode,
        force: isJobAiEnriched(job),
      });
    } finally {
      if (!this.destroyed) {
        this.inFlightSingleEnrichIds.delete(job.id);
      }
    }
  }

  async startBatchEnrich(
    jobIds: number[],
    opts?: Partial<Omit<BatchEnrichRequest, 'job_ids'>>,
  ): Promise<void> {
    if (this.destroyed) return;
    const sessionSeq = this.batchStateSeq;
    if (!this.hasActiveTrackedBatches() && this.inFlightStartBatchCount === 0) {
      this.pendingSessionResetIds.clear();
      for (const [id, existing] of this.trackedBatches.entries()) {
        if (!this.isBatchActive(existing.batch)) {
          this.pendingSessionResetIds.add(id);
        }
      }
    }
    this.inFlightStartBatchCount += 1;
    this.clearError();
    try {
      const payload: BatchEnrichRequest = {
        job_ids: jobIds,
        mode: opts?.mode ?? this.config.default_mode,
        force: opts?.force ?? this.config.default_force,
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.effort ? { effort: opts.effort } : {}),
        triggered_by: 'ui',
      };
      const detail = await this.requestJson<EnrichmentBatchDetailResponse>('/api/jobs/enrich', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (this.destroyed || sessionSeq !== this.batchStateSeq) return;
      if (this.pendingSessionResetIds.size > 0) {
        for (const id of this.pendingSessionResetIds) {
          const existing = this.trackedBatches.get(id);
          if (existing && !this.isBatchActive(existing.batch)) {
            this.trackedBatches.delete(id);
          }
        }
        this.pendingSessionResetIds.clear();
      }
      this.isPollInFlight = false;
      this.pollTokenCounter += 1;
      this.pinnedBatchId = null;
      this.nextBatchSeq(detail.batch.id);
      this.trackedBatches.set(detail.batch.id, detail);
      this.renderBatchBanner();
      if (this.hasActiveTrackedBatches()) {
        this.startBatchPolling();
      } else {
        this.stopBatchPolling();
      }
      await this.loadJobs();
    } catch (err) {
      if (this.destroyed || sessionSeq !== this.batchStateSeq) return;
      this.showError(err instanceof Error ? err.message : 'Failed to start enrichment batch');
    } finally {
      if (!this.destroyed) {
        this.inFlightStartBatchCount = Math.max(0, this.inFlightStartBatchCount - 1);
        if (this.inFlightStartBatchCount === 0) {
          this.pendingSessionResetIds.clear();
        }
      }
    }
  }

  private isBatchActive(batch: EnrichmentBatchSummary): boolean {
    return batch.status === 'queued' || batch.status === 'running';
  }

  private hasActiveTrackedBatches(): boolean {
    for (const detail of this.trackedBatches.values()) {
      if (this.isBatchActive(detail.batch)) return true;
    }
    return false;
  }

  private nextBatchSeq(batchId: number): number {
    const next = (this.batchSeqById.get(batchId) ?? 0) + 1;
    this.batchSeqById.set(batchId, next);
    return next;
  }

  private async loadActiveBatches(): Promise<void> {
    if (this.destroyed) return;
    const sessionSeq = this.batchStateSeq;
    try {
      if (this.pinnedBatchId !== null) {
        const targetId = this.pinnedBatchId;
        if (this.cancelingBatchIds.has(targetId)) return;
        const reqSeq = this.nextBatchSeq(targetId);
        const detail = await this.requestJson<EnrichmentBatchDetailResponse>(
          `/api/enrichment-batches/${targetId}`,
          { method: 'GET' },
        );
        if (
          this.destroyed ||
          sessionSeq !== this.batchStateSeq ||
          this.pinnedBatchId !== targetId ||
          (this.batchSeqById.get(targetId) ?? 0) !== reqSeq
        ) {
          return;
        }
        this.isPollInFlight = false;
        this.pollTokenCounter += 1;
        this.trackedBatches.set(detail.batch.id, detail);
        this.renderBatchBanner();
        if (this.hasActiveTrackedBatches()) {
          this.startBatchPolling();
        } else {
          this.stopBatchPolling();
        }
        return;
      }

      const list = await this.requestJson<EnrichmentBatchesListResponse>(
        '/api/enrichment-batches?limit=20',
        { method: 'GET' },
      );
      if (this.destroyed || sessionSeq !== this.batchStateSeq) return;
      const activeSummaries = (Array.isArray(list.batches) ? list.batches : []).filter(
        (b) => this.isBatchActive(b) && !this.cancelingBatchIds.has(b.id),
      );
      if (activeSummaries.length === 0) {
        return;
      }

      const snapshots = activeSummaries.map((b) => ({
        id: b.id,
        reqSeq: this.nextBatchSeq(b.id),
      }));
      const details = await Promise.all(
        snapshots.map(async (snap) => {
          try {
            const detail = await this.requestJson<EnrichmentBatchDetailResponse>(
              `/api/enrichment-batches/${snap.id}`,
              { method: 'GET' },
            );
            return { snap, detail };
          } catch (err) {
            if (isUnauthorizedError(err)) throw err;
            return null;
          }
        }),
      );
      if (this.destroyed || sessionSeq !== this.batchStateSeq) return;

      let updated = false;
      for (const entry of details) {
        if (!entry) continue;
        const { snap, detail } = entry;
        if ((this.batchSeqById.get(snap.id) ?? 0) !== snap.reqSeq) {
          continue;
        }
        this.trackedBatches.set(detail.batch.id, detail);
        updated = true;
      }
      if (updated) {
        this.isPollInFlight = false;
        this.pollTokenCounter += 1;
        this.renderBatchBanner();
        if (this.hasActiveTrackedBatches()) {
          this.startBatchPolling();
        } else {
          this.stopBatchPolling();
        }
      }
    } catch {
      // ignore non-fatal errors on initial/refresh load; 401 is handled by requestJson
    }
  }

  private startBatchPolling(): void {
    if (this.pollTimer !== null || this.destroyed) return;
    this.pollTimer = setInterval(() => {
      void this.pollBatchTick();
    }, 2000);
  }

  private stopBatchPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollBatchTick(): Promise<void> {
    if (this.destroyed || this.isPollInFlight) return;
    const activeEntries: Array<{ id: number; reqSeq: number }> = [];
    for (const [id, detail] of this.trackedBatches.entries()) {
      if (this.isBatchActive(detail.batch) && !this.cancelingBatchIds.has(id)) {
        activeEntries.push({ id, reqSeq: this.nextBatchSeq(id) });
      }
    }
    if (activeEntries.length === 0) {
      if (!this.hasActiveTrackedBatches()) {
        this.stopBatchPolling();
      }
      return;
    }

    this.isPollInFlight = true;
    const pollToken = ++this.pollTokenCounter;
    const sessionSeq = this.batchStateSeq;
    try {
      const results = await Promise.all(
        activeEntries.map(async ({ id, reqSeq }) => {
          try {
            const detail = await this.requestJson<EnrichmentBatchDetailResponse>(
              `/api/enrichment-batches/${id}`,
              { method: 'GET' },
            );
            return { id, reqSeq, detail };
          } catch (err) {
            if (isUnauthorizedError(err)) {
              throw err;
            }
            return null;
          }
        }),
      );

      if (this.destroyed || sessionSeq !== this.batchStateSeq) {
        return;
      }

      let anyUpdated = false;
      for (const item of results) {
        if (!item) continue;
        if ((this.batchSeqById.get(item.id) ?? 0) !== item.reqSeq) {
          continue;
        }
        this.trackedBatches.set(item.id, item.detail);
        anyUpdated = true;
      }

      if (anyUpdated) {
        this.renderBatchBanner();
        await this.loadJobs();
        if (this.destroyed || sessionSeq !== this.batchStateSeq) {
          return;
        }
      }

      if (!this.hasActiveTrackedBatches()) {
        this.stopBatchPolling();
      }
    } catch (err) {
      if (this.destroyed || sessionSeq !== this.batchStateSeq) {
        return;
      }
      if (isUnauthorizedError(err)) {
        this.stopBatchPolling();
        this.showError(err instanceof Error ? err.message : 'Unauthorized (401)');
      }
      // keep polling on transient error unless destroyed or unauthorized
    } finally {
      if (this.pollTokenCounter === pollToken) {
        this.isPollInFlight = false;
      }
    }
  }

  private async cancelActiveBatches(): Promise<void> {
    if (this.destroyed) return;
    const targets: Array<{ id: number; cancelSeq: number }> = [];
    for (const [id, detail] of this.trackedBatches.entries()) {
      if (this.isBatchActive(detail.batch) && !this.cancelingBatchIds.has(id)) {
        const cancelSeq = this.nextBatchSeq(id);
        this.cancelingBatchIds.add(id);
        targets.push({ id, cancelSeq });
      }
    }
    if (targets.length === 0) return;

    const sessionSeq = this.batchStateSeq;
    try {
      const settled = await Promise.allSettled(
        targets.map(async ({ id, cancelSeq }) => {
          const detail = await this.requestJson<EnrichmentBatchDetailResponse>(
            `/api/enrichment-batches/${id}/cancel`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            },
          );
          return { id, cancelSeq, detail };
        }),
      );
      if (this.destroyed || sessionSeq !== this.batchStateSeq) return;

      let firstError: unknown = null;
      let anyUpdated = false;
      for (const result of settled) {
        if (result.status === 'fulfilled') {
          const { id, cancelSeq, detail } = result.value;
          if ((this.batchSeqById.get(id) ?? 0) === cancelSeq) {
            this.nextBatchSeq(id);
            this.trackedBatches.set(id, detail);
            anyUpdated = true;
          }
        } else if (firstError === null) {
          firstError = result.reason;
        }
      }

      if (anyUpdated) {
        this.isPollInFlight = false;
        this.pollTokenCounter += 1;
        this.renderBatchBanner();
        if (!this.hasActiveTrackedBatches()) {
          this.stopBatchPolling();
        }
        await this.loadJobs();
      }
      if (firstError !== null && !this.destroyed && sessionSeq === this.batchStateSeq) {
        this.showError(firstError instanceof Error ? firstError.message : 'Failed to cancel batch');
      }
    } catch (err) {
      if (this.destroyed || sessionSeq !== this.batchStateSeq) return;
      this.showError(err instanceof Error ? err.message : 'Failed to cancel batch');
    } finally {
      for (const { id } of targets) {
        this.cancelingBatchIds.delete(id);
      }
    }
  }

  private aggregateBatchStatus(details: EnrichmentBatchDetailResponse[]): string {
    const priority = ['running', 'queued', 'canceled', 'failed', 'completed_with_errors', 'completed'];
    const statuses = new Set(details.map((d) => String(d.batch.status ?? '')));
    for (const candidate of priority) {
      if (statuses.has(candidate)) {
        return candidate;
      }
    }
    return String(details[0]?.batch.status ?? 'completed');
  }

  private renderBatchBanner(): void {
    if (this.trackedBatches.size === 0) {
      this.batchBannerEl.innerHTML = '';
      this.batchBannerEl.hidden = true;
      return;
    }

    const details = Array.from(this.trackedBatches.values());
    let totalCount = 0;
    let queuedCount = 0;
    let runningCount = 0;
    let completedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let canceledCount = 0;
    let totalTokensUsed = 0;
    let totalItemsCount = 0;

    for (const detail of details) {
      const b = detail.batch;
      totalCount += Math.max(0, finiteNumberOr(b.total_count, 0));
      queuedCount += Math.max(0, finiteNumberOr(b.queued_count, 0));
      runningCount += Math.max(0, finiteNumberOr(b.running_count, 0));
      completedCount += Math.max(0, finiteNumberOr(b.completed_count, 0));
      skippedCount += Math.max(0, finiteNumberOr(b.skipped_count, 0));
      failedCount += Math.max(0, finiteNumberOr(b.failed_count, 0));
      canceledCount += Math.max(0, finiteNumberOr(b.canceled_count, 0));
      totalTokensUsed += Math.max(0, finiteNumberOr(b.total_tokens_used, 0));
      if (Array.isArray(detail.items)) {
        totalItemsCount += detail.items.length;
      }
    }

    const finishedCount = completedCount + skippedCount + failedCount + canceledCount;
    const rawPct = totalCount > 0 ? Math.round((finishedCount / totalCount) * 100) : 0;
    const pct = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : 0;
    const isRunning = details.some((d) => this.isBatchActive(d.batch));

    let headerText: string;
    if (details.length === 1) {
      const only = details[0].batch;
      const safeBatchId = escapeHtml(String(finiteNumberOr(only.id, 0)));
      headerText = `Batch #${safeBatchId} (${escapeHtml(String(only.mode ?? ''))}) — ${escapeHtml(String(only.status ?? ''))}`;
    } else {
      const modes = new Set(details.map((d) => String(d.batch.mode ?? '')));
      const aggMode = modes.size === 1 ? Array.from(modes)[0] : 'mixed';
      const aggStatus = this.aggregateBatchStatus(details);
      headerText = `${escapeHtml(String(details.length))} batches (${escapeHtml(aggMode)}) — ${escapeHtml(aggStatus)}`;
    }

    const jobTitlesById = new Map<number, string>();
    for (const job of this.allJobs) {
      if (job.job_title) {
        jobTitlesById.set(job.id, job.job_title);
      }
    }

    const itemsHtml = this.batchItemsExpanded
      ? `<div class="dash-batch-items">${details
          .flatMap((detail) => {
            const batchId = finiteNumberOr(detail.batch.id, 0);
            const safeBatchId = escapeHtml(String(batchId));
            const items = Array.isArray(detail.items) ? detail.items : [];
            return items.map((item) => {
              const jobIdNum = finiteNumberOr(item.job_id, 0);
              const safeJobId = escapeHtml(String(jobIdNum));
              const rawTitle = jobTitlesById.get(jobIdNum) ?? '';
              const truncatedTitle =
                rawTitle.length > 60 ? `${rawTitle.slice(0, 57)}...` : rawTitle;
              const safeTitleHtml = truncatedTitle ? ` · ${escapeHtml(truncatedTitle)}` : '';
              const safeItemTokens = escapeHtml(
                String(Math.max(0, finiteNumberOr(item.total_tokens, 0))),
              );
              return `<div class="dash-batch-item-row">
                ${details.length > 1 ? `<span>Batch #${safeBatchId}</span>` : ''}
                <span>Job #${safeJobId}${safeTitleHtml}</span>
                <span>${escapeHtml(String(item.status ?? ''))}</span>
                <span>${safeItemTokens} tokens</span>
                ${item.error_message ? `<span class="dash-err-text">${escapeHtml(String(item.error_message))}</span>` : ''}
              </div>`;
            });
          })
          .join('')}</div>`
      : '';

    const safeFinished = escapeHtml(String(finishedCount));
    const safeTotal = escapeHtml(String(totalCount));
    const safePct = escapeHtml(String(pct));
    const safeRunning = escapeHtml(String(runningCount));
    const safeQueued = escapeHtml(String(queuedCount));
    const safeCompleted = escapeHtml(String(completedCount));
    const safeSkipped = escapeHtml(String(skippedCount));
    const safeFailed = escapeHtml(String(failedCount));
    const safeCanceled = escapeHtml(String(canceledCount));
    const safeTokens = escapeHtml(String(totalTokensUsed));
    const safeItemsLen = escapeHtml(String(totalItemsCount));
    const activePart =
      isRunning || runningCount > 0 || queuedCount > 0
        ? `running ${safeRunning} · queued ${safeQueued} · `
        : '';

    this.batchBannerEl.hidden = false;
    this.batchBannerEl.innerHTML = `
      <div class="dash-batch-row">
        <div class="dash-batch-meta">
          <strong>${headerText}</strong>
          <span>${safeFinished}/${safeTotal} (${safePct}%) · ${activePart}completed ${safeCompleted} · skipped ${safeSkipped} · failed ${safeFailed} · canceled ${safeCanceled} · ${safeTokens} tokens</span>
        </div>
        <div class="dash-batch-actions">
          <button type="button" class="dash-btn-sm" data-testid="batch-items-toggle">
            ${this.batchItemsExpanded ? 'Hide Items' : `Items (${safeItemsLen})`}
          </button>
          ${
            isRunning
              ? `<button type="button" class="dash-btn-danger" data-testid="cancel-batch-btn">Cancel Remaining</button>`
              : `<button type="button" class="dash-btn-sm" data-testid="dismiss-batch-banner-btn">Dismiss</button>`
          }
        </div>
      </div>
      <div class="dash-progress-track"><div class="dash-progress-fill" style="width: ${safePct}%"></div></div>
      ${itemsHtml}
    `;
  }

  private async handleRunSearchSubmit(): Promise<void> {
    if (this.destroyed) return;
    const queriesRaw = this.mustQuery<HTMLInputElement>('#dash-search-queries').value;
    const queries = queriesRaw
      .split(/[\n,]+/)
      .map((q) => q.trim())
      .filter(Boolean);
    const matchProjects = this.mustQuery<HTMLInputElement>('#dash-match-active-cb').checked;
    const source = this.mustQuery<HTMLSelectElement>('#dash-search-source').value || 'search';
    const contractType = this.mustQuery<HTMLSelectElement>('#dash-search-contract').value;
    const rateMinRaw = this.mustQuery<HTMLInputElement>('#dash-search-rate-min').value;
    const rateMaxRaw = this.mustQuery<HTMLInputElement>('#dash-search-rate-max').value;
    const budgetMinRaw = this.mustQuery<HTMLInputElement>('#dash-search-budget-min').value;
    const budgetMaxRaw = this.mustQuery<HTMLInputElement>('#dash-search-budget-max').value;
    const maxPagesRaw = this.mustQuery<HTMLInputElement>('#dash-search-max-pages').value;
    const runLabel = this.mustQuery<HTMLInputElement>('#dash-search-run-label').value.trim();
    const paymentVerifiedOnly = this.mustQuery<HTMLInputElement>(
      '#dash-search-payment-verified',
    ).checked;

    const statusEl = this.mustQuery('#dash-search-panel-status');
    const submitBtn = this.mustQuery<HTMLButtonElement>('#dash-run-search-submit');
    submitBtn.disabled = true;
    statusEl.textContent = 'Running Upwork search (0 LLM tokens)...';
    this.clearError();

    const payload: Record<string, unknown> = {
      source,
      skip_auto_detail_enrich: true,
      from_active_projects: matchProjects,
      max_pages: Math.max(1, Number.parseInt(maxPagesRaw, 10) || 1),
      triggered_by: 'ui',
    };
    if (queries.length === 1) {
      payload.query = queries[0];
    } else if (queries.length > 1) {
      payload.queries = queries;
    }
    if (contractType) payload.contract_type = contractType;
    if (rateMinRaw.trim()) payload.hourly_rate_min = Number.parseFloat(rateMinRaw);
    if (rateMaxRaw.trim()) payload.hourly_rate_max = Number.parseFloat(rateMaxRaw);
    if (budgetMinRaw.trim()) payload.budget_min = Number.parseFloat(budgetMinRaw);
    if (budgetMaxRaw.trim()) payload.budget_max = Number.parseFloat(budgetMaxRaw);
    if (paymentVerifiedOnly) payload.payment_verified_only = true;
    if (runLabel) payload.run_label = runLabel;

    try {
      if (this.destroyed) return;
      const res = await this.requestJson<{
        search_run_id?: number;
        jobs?: SavedJob[];
        stopped_reason?: string;
      }>('/api/jobs/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (this.destroyed) return;
      statusEl.textContent = `Saved ${res.jobs?.length ?? 0} jobs (${res.stopped_reason ?? 'done'})`;
      await this.loadSearchRuns();
      if (this.destroyed) return;
      if (
        typeof res.search_run_id === 'number' &&
        Number.isFinite(res.search_run_id) &&
        res.search_run_id > 0
      ) {
        this.selectedRunId = String(res.search_run_id);
        this.searchRunSelectEl.value = this.selectedRunId;
      }
      await this.loadJobs();
    } catch (err) {
      if (this.destroyed) return;
      const msg = err instanceof Error ? err.message : 'Search failed';
      statusEl.textContent = msg;
      this.showError(msg);
    } finally {
      if (!this.destroyed) {
        submitBtn.disabled = false;
      }
    }
  }

  private async handleStatusChange(jobId: number, nextStatus: string): Promise<void> {
    if (this.destroyed) return;
    try {
      const res = await this.requestJson<{ job: SavedJob }>(`/api/jobs/${jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (this.destroyed) return;
      if (res.job) {
        this.mergeUpdatedJob(res.job);
      }
    } catch (err) {
      if (this.destroyed) return;
      this.showError(err instanceof Error ? err.message : 'Failed to update status');
    }
  }

  private async enrichJobFromDrawer(job: SavedJob): Promise<SavedJob | null> {
    if (this.destroyed) return null;
    const model = this.bulkModelInput.value.trim() || this.config.default_model;
    const effort = this.bulkEffortSelect.value || this.config.default_effort;
    const res = await this.requestJson<AnalyzeSavedJobResponse>(`/api/jobs/${job.id}/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        use_llm: true,
        ensure_details: true,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      }),
    });
    if (this.destroyed) return null;
    if (res.job) {
      const merged: SavedJob =
        res.llm_error && !res.job.ai_enrichment_error
          ? {
              ...res.job,
              ai_enrichment_status: res.job.ai_enrichment_status || 'failed',
              ai_enrichment_error: res.llm_error,
            }
          : res.job;
      this.mergeUpdatedJob(merged);
      return merged;
    }
    await this.loadJobs();
    if (this.destroyed) return null;
    return this.allJobs.find((j) => j.id === job.id) ?? null;
  }

  private async saveProposalDraftFromDrawer(job: SavedJob): Promise<void> {
    if (this.destroyed) return;
    if (!job.proposal?.trim()) {
      throw new Error('Generate an AI proposal before saving a draft.');
    }
    const req: SaveProposalRequest = {
      job_id: job.id,
      ...(job.upwork_job_id ? { upwork_job_id: job.upwork_job_id } : {}),
      cover_letter: job.proposal,
      bid_type:
        job.contract_type === 'hourly' || job.contract_type === 'fixed' ? job.contract_type : '',
      connects_required: job.connects_required ?? null,
      portfolio_refs: job.portfolio_references ?? [],
      status: 'draft',
    };
    await this.requestJson('/api/proposals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (this.destroyed) return;
  }

  private mergeUpdatedJob(updated: SavedJob): void {
    const idx = this.allJobs.findIndex((j) => j.id === updated.id);
    if (idx >= 0) {
      this.allJobs[idx] = updated;
    } else {
      this.allJobs.unshift(updated);
    }
    this.applyClientFilters();
    this.drawer.updateJobIfOpen(updated);
  }
}
