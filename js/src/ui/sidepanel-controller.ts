import { browser } from 'wxt/browser';
import { ApiClient, createExtensionProxyTransport } from '../api';
import type {
  BrokenFieldDiagnosis,
  DriftAuditReport,
  RuntimeStatusSnapshot,
  SelectorPatchTestResult,
  UiDiagnosticCapture,
} from '../shared/protocol';
import type { SearchProfileEntry } from '../shared/schemas';
import type { ExtractMode } from '../shared/selectors';
import { StateManager } from '../state';
import type { GeneratedAgent, SavedJob, WatchersStatusResponse } from '../types';
import { attachCollapsibleListeners, escapeHtml, renderAnalysis, sanitizeHttpUrl } from '../utils';
import { JobHistoryPanel } from './job-history';
import { ProfileConfigUI } from './profile-config';
import { ProjectsListUI } from './projects-list';
import { TemplateBrowser } from './template-browser';

export type SidePanelTabId =
  | 'pipeline'
  | 'approvals'
  | 'messages'
  | 'activity'
  | 'agents'
  | 'selectors';

export interface SidePanelElements {
  root: ParentNode;
  connectionPill: HTMLElement;
  policyBadge: HTMLElement;
  killSwitchBtn: HTMLButtonElement;
  approvalsBadge: HTMLElement;
  unreadBadge: HTMLElement;
  tabButtons: HTMLButtonElement[];
  contentEl: HTMLElement;
}

interface ProposalSnapshotView {
  cover_letter_length?: number;
  bid_type?: string;
  bid_amount?: number | null;
  estimated_fee?: number | null;
  estimated_net?: number | null;
  connects_cost?: number | null;
  boost_connects?: number | null;
  total_connects?: number | null;
  available_connects?: number | null;
  rate_increase?: string;
  unanswered_required_questions?: number;
  screening_answers?: Array<{
    prompt?: string;
    answer?: string;
    required?: boolean;
  }>;
}

interface ProposalRow {
  id: number;
  job_id?: number;
  upwork_job_id?: string;
  job_title?: string;
  cover_letter?: string;
  bid_type?: string;
  bid_amount?: number | null;
  rate_increase?: string;
  connects_required?: number | null;
  boost_connects?: number | null;
  total_connects?: number | null;
  status?: string;
  source?: string;
  verification_snapshot_json?: (ProposalSnapshotView & { triggered_by?: string }) | string | null;
}

interface ThreadRow {
  id?: number;
  upwork_room_id: string;
  client_name: string;
  job_title?: string;
  unread_count: number;
  last_message_snippet: string;
}

interface MessageDraftRow {
  id: number;
  thread_id?: number;
  upwork_room_id?: string;
  room_id?: string;
  client_name?: string;
  job_title?: string;
  body: string;
  status?: string;
  created_at?: string;
}

interface PolicySnapshot {
  mode?: string;
  auto_submit_proposals?: boolean;
  auto_send_messages?: boolean;
  proposals_today?: number;
  max_proposals_per_day?: number;
  connects_today?: number;
  max_connects_per_day?: number;
  messages_today?: number;
  max_messages_per_day?: number;
  min_job_score?: number;
  allowed_room_ids?: string[];
  quiet_hours?: string | null;
  pending_approvals?: number;
  kill_switch_active?: boolean;
}

interface AuditLogRow {
  id?: number;
  action_type?: string;
  actor?: string;
  outcome?: string;
  created_at?: string;
}

interface SelectorAuditRow {
  id: number;
  view_type: string;
  overall_status: string;
  created_at: string;
  report?: DriftAuditReport;
}

export class SidePanelController {
  private readonly apiClient: ApiClient;
  private readonly stateManager: StateManager;
  private readonly proxyTransport: (url: string, init?: RequestInit) => Promise<Response>;
  private activeTab: SidePanelTabId = 'pipeline';
  private filterMinScore = '';
  private filterFit = '';
  private filterQuery = '';
  private searchQueryInput = '';
  private searchSourceInput: 'search' | 'best_matches' | 'most_recent' | 'saved_jobs' = 'search';
  private searchContractInput: '' | 'hourly' | 'fixed' = '';
  private searchMaxPagesInput = '1';
  private searchEnrichTopNInput = '0';
  private searchStatusMessage = '';
  private approvalsStatusMessage = '';
  private approvalsStatusError = false;
  private messagesStatusMessage = '';
  private messagesStatusError = false;
  private policyStatusMessage = '';
  private policyStatusError = false;
  private activeAgentsSubTab: 'profile' | 'cache' | 'history' | 'blueprints' = 'profile';
  private listenersAttached = false;
  private tabSelectedBeforeInitDone = false;
  private includeScreenshot = false;
  private latestCaptureDetail: {
    capture_uid?: string;
    markdown?: string;
    entry?: {
      id?: number;
      capture_uid?: string;
      view_type?: string;
      page_url?: string;
      overall_status?: string;
      broken_count?: number;
      created_at?: string;
      broken_fields?: BrokenFieldDiagnosis[];
    };
    capture?: UiDiagnosticCapture;
  } | null = null;
  private patchTestFeedback = new Map<string, string>();
  private cachedBudgetText = {
    proposals: '0 / 5',
    connects: '0 / 50',
    messages: '0 / 20',
  };
  private watchersStatus: WatchersStatusResponse | null = null;

  constructor(
    private readonly els: SidePanelElements,
    deps?: {
      apiClient?: ApiClient;
      stateManager?: StateManager;
      proxyTransport?: (url: string, init?: RequestInit) => Promise<Response>;
    },
  ) {
    this.proxyTransport = deps?.proxyTransport ?? createExtensionProxyTransport();
    this.apiClient = deps?.apiClient ?? new ApiClient(this.proxyTransport);
    this.stateManager = deps?.stateManager ?? new StateManager({ apiClient: this.apiClient });
  }

  async init(): Promise<void> {
    if (!this.listenersAttached) {
      this.listenersAttached = true;
      for (const btn of this.els.tabButtons) {
        btn.addEventListener('click', () => {
          const tabId = btn.dataset.tab as SidePanelTabId | undefined;
          if (tabId) {
            this.tabSelectedBeforeInitDone = true;
            void this.switchTab(tabId);
          }
        });
      }

      this.els.killSwitchBtn.addEventListener('click', () => {
        void this.triggerKillSwitch();
      });

      if (typeof browser?.runtime?.onMessage?.addListener === 'function') {
        browser.runtime.onMessage.addListener((rawMsg: unknown) => {
          const msg = rawMsg as { type?: string; tab?: string };
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'SIDEPANEL_SWITCH_TAB' && this.isValidSidePanelTab(msg.tab)) {
            this.tabSelectedBeforeInitDone = true;
            void this.switchTab(msg.tab);
          } else if (msg.type === 'SIDEPANEL_SELECTORS_UPDATED' && this.activeTab === 'selectors') {
            void this.renderSelectorsTab();
          }
        });
      }
    }

    await this.stateManager.initializeStorage().catch(() => undefined);
    await this.refreshHeaderStatus();
    if (!this.tabSelectedBeforeInitDone) {
      let initialTab: SidePanelTabId = 'pipeline';
      if (typeof window !== 'undefined' && typeof window.location?.search === 'string') {
        const paramTab = new URLSearchParams(window.location.search).get('tab');
        if (this.isValidSidePanelTab(paramTab)) {
          initialTab = paramTab;
        }
      }
      if (initialTab === 'pipeline') {
        const pending = (await browser.runtime
          .sendMessage({ type: 'BG_GET_PENDING_SIDEPANEL_TAB' })
          .catch(() => null)) as { tab?: string | null } | null;
        if (this.isValidSidePanelTab(pending?.tab)) {
          initialTab = pending.tab;
        }
      }
      await this.switchTab(initialTab);
    }
  }

  private isValidSidePanelTab(tab: string | null | undefined): tab is SidePanelTabId {
    return (
      tab === 'pipeline' ||
      tab === 'approvals' ||
      tab === 'messages' ||
      tab === 'activity' ||
      tab === 'agents' ||
      tab === 'selectors'
    );
  }

  getActiveTab(): SidePanelTabId {
    return this.activeTab;
  }

  async switchTab(tabId: SidePanelTabId): Promise<void> {
    const prevTab = this.activeTab;
    this.tabSelectedBeforeInitDone = true;
    this.activeTab = tabId;
    const budgetBar = this.els.root.querySelector<HTMLElement>('#sp-budget-bar');
    if (budgetBar) {
      const propEl = budgetBar.querySelector<HTMLElement>('#sp-budget-proposals');
      const connEl = budgetBar.querySelector<HTMLElement>('#sp-budget-connects');
      const msgEl = budgetBar.querySelector<HTMLElement>('#sp-budget-messages');
      if (tabId === 'activity') {
        if (propEl?.textContent?.trim())
          this.cachedBudgetText.proposals = propEl.textContent.trim();
        if (connEl?.textContent?.trim()) this.cachedBudgetText.connects = connEl.textContent.trim();
        if (msgEl?.textContent?.trim()) this.cachedBudgetText.messages = msgEl.textContent.trim();
        budgetBar.style.display = 'none';
        if (propEl) propEl.textContent = '';
        if (connEl) connEl.textContent = '';
        if (msgEl) msgEl.textContent = '';
      } else {
        budgetBar.style.display = '';
        if (prevTab === 'activity' || !propEl?.textContent?.trim()) {
          if (propEl) propEl.textContent = this.cachedBudgetText.proposals;
        }
        if (prevTab === 'activity' || !connEl?.textContent?.trim()) {
          if (connEl) connEl.textContent = this.cachedBudgetText.connects;
        }
        if (prevTab === 'activity' || !msgEl?.textContent?.trim()) {
          if (msgEl) msgEl.textContent = this.cachedBudgetText.messages;
        }
      }
    }
    if (prevTab === 'activity' && tabId !== 'activity') {
      void this.refreshHeaderStatus();
    }
    for (const btn of this.els.tabButtons) {
      const selected = btn.dataset.tab === tabId;
      btn.setAttribute('aria-selected', selected ? 'true' : 'false');
      btn.classList.toggle('active', selected);
    }

    switch (tabId) {
      case 'pipeline':
        await this.renderPipelineTab();
        break;
      case 'approvals':
        await this.renderApprovalsTab();
        break;
      case 'messages':
        await this.renderMessagesTab();
        break;
      case 'activity':
        await this.renderActivityTab();
        break;
      case 'agents':
        await this.renderAgentsTab();
        break;
      case 'selectors':
        await this.renderSelectorsTab();
        break;
    }
  }

  async refreshHeaderStatus(): Promise<RuntimeStatusSnapshot | null> {
    let runtimeStatus: RuntimeStatusSnapshot | null = null;
    try {
      const [status, policy, unread, watchersStatus] = await Promise.all([
        browser.runtime
          .sendMessage({ type: 'GET_RUNTIME_STATUS' })
          .catch(() => null) as Promise<RuntimeStatusSnapshot | null>,
        this.fetchJsonSafe<PolicySnapshot>('/api/policy', { method: 'GET' }),
        this.fetchJsonSafe<{ total_unread?: number }>('/api/messages/unread', { method: 'GET' }),
        this.fetchJsonSafe<WatchersStatusResponse>('/api/watchers/status', { method: 'GET' }),
      ]);

      if (watchersStatus && typeof watchersStatus.active_rules === 'number') {
        this.watchersStatus = watchersStatus;
      }

      if (status && typeof status === 'object') {
        runtimeStatus = status;
        this.els.connectionPill.textContent = status.wsConnected ? 'WS Connected' : 'WS Offline';
        this.els.connectionPill.dataset.connected = status.wsConnected ? 'true' : 'false';
        this.els.policyBadge.textContent = policy?.mode ?? status.policyMode ?? 'confirm_in_ui';
        this.els.approvalsBadge.textContent = String(
          policy?.pending_approvals ?? status.pendingApprovalsCount ?? 0,
        );
        if (typeof status.unreadMessagesCount === 'number') {
          this.els.unreadBadge.textContent = String(status.unreadMessagesCount);
        }
      }

      if (policy && typeof policy === 'object' && policy.mode) {
        this.els.policyBadge.textContent = policy.mode;
        if (typeof policy.pending_approvals === 'number') {
          this.els.approvalsBadge.textContent = String(policy.pending_approvals);
        }
        this.cachedBudgetText = {
          proposals: `${policy.proposals_today ?? 0} / ${policy.max_proposals_per_day ?? 5}`,
          connects: `${policy.connects_today ?? 0} / ${policy.max_connects_per_day ?? 50}`,
          messages: `${policy.messages_today ?? 0} / ${policy.max_messages_per_day ?? 20}`,
        };
        const propEl = this.els.root.querySelector<HTMLElement>('#sp-budget-proposals');
        const connEl = this.els.root.querySelector<HTMLElement>('#sp-budget-connects');
        const msgEl = this.els.root.querySelector<HTMLElement>('#sp-budget-messages');
        if (this.activeTab !== 'activity') {
          if (propEl) propEl.textContent = this.cachedBudgetText.proposals;
          if (connEl) connEl.textContent = this.cachedBudgetText.connects;
          if (msgEl) msgEl.textContent = this.cachedBudgetText.messages;
        }
      }

      if (unread && typeof unread.total_unread === 'number') {
        this.els.unreadBadge.textContent = String(unread.total_unread);
      }
    } catch {
      // ignore
    }
    return runtimeStatus;
  }

  async triggerKillSwitch(): Promise<void> {
    try {
      await browser.runtime.sendMessage({
        type: 'TRIGGER_KILL_SWITCH',
        reason: 'Kill switch pressed in Side Panel',
      });
      this.els.policyBadge.textContent = 'draft_only';
      if (this.activeTab === 'activity') {
        await this.renderActivityTab();
      }
    } catch {
      // ignore
    }
  }

  private async fetchJsonSafe<T>(path: string, init?: RequestInit): Promise<T | null> {
    try {
      const res = await this.proxyTransport(path, init);
      if (!res.ok) {
        return null;
      }
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  private renderJobDetailV2Sections(found: SavedJob): string {
    const sections: string[] = [];

    if (found.screening_questions && found.screening_questions.length > 0) {
      const items = found.screening_questions
        .map(
          (q) =>
            `<li>${escapeHtml(q.prompt)}${q.required ? ' <strong>(Required)</strong>' : ''}</li>`,
        )
        .join('');
      sections.push(`<div class="sp-v2-block"><h5>Screening Questions</h5><ol>${items}</ol></div>`);
    }

    if (found.qualifications && found.qualifications.length > 0) {
      const items = found.qualifications
        .map((q) => {
          const badge = q.met === true ? '✓' : q.met === false ? '✗' : '•';
          return `<li>${escapeHtml(badge)} <strong>${escapeHtml(q.name)}:</strong> ${escapeHtml(q.value)}</li>`;
        })
        .join('');
      sections.push(`<div class="sp-v2-block"><h5>Qualifications</h5><ul>${items}</ul></div>`);
    }

    if (found.attachments && found.attachments.length > 0) {
      const items = found.attachments
        .map((att) => {
          const safe = sanitizeHttpUrl(att.url);
          if (!safe) {
            return `<li>${escapeHtml(att.filename)}</li>`;
          }
          return `<li><a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(att.filename)}</a></li>`;
        })
        .join('');
      sections.push(`<div class="sp-v2-block"><h5>Attachments</h5><ul>${items}</ul></div>`);
    }

    if (found.client_activity && Object.keys(found.client_activity).length > 0) {
      const ca = found.client_activity;
      const parts: string[] = [];
      if (ca.interviewing !== undefined)
        parts.push(`Interviewing: ${escapeHtml(String(ca.interviewing))}`);
      if (ca.invites_sent !== undefined)
        parts.push(`Invites: ${escapeHtml(String(ca.invites_sent))}`);
      if (ca.unanswered_invites !== undefined) {
        parts.push(`Unanswered: ${escapeHtml(String(ca.unanswered_invites))}`);
      }
      if (ca.last_viewed) parts.push(`Last viewed: ${escapeHtml(ca.last_viewed)}`);
      if (ca.avg_hourly_rate_paid) {
        parts.push(`Avg hourly paid: ${escapeHtml(ca.avg_hourly_rate_paid)}`);
      }
      if (parts.length > 0) {
        sections.push(
          `<div class="sp-v2-block"><h5>Client Activity</h5><p>${parts.join(' | ')}</p></div>`,
        );
      }
    }

    if (found.score_breakdown && Object.keys(found.score_breakdown).length > 0) {
      const entries = Object.entries(found.score_breakdown)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(
          ([k, v]) =>
            `<li>${escapeHtml(k)}: ${escapeHtml(Array.isArray(v) ? v.join(', ') : String(v))}</li>`,
        )
        .join('');
      if (entries) {
        sections.push(
          `<details class="sp-v2-block"><summary>Score Breakdown</summary><ul>${entries}</ul></details>`,
        );
      }
    }

    return sections.join('');
  }

  private renderWatchersSummaryHtml(): string {
    const ws = this.watchersStatus;
    if (!ws) return '';
    const text =
      ws.paused_rules > 0
        ? `Watchers: ${ws.active_rules} active · ${ws.paused_rules} paused`
        : `Watchers: ${ws.active_rules} active`;
    return `<div class="sp-meta" data-testid="sp-watchers-summary"><span class="${ws.paused_rules > 0 ? 'score-pill' : 'badge-tag'}">${escapeHtml(text)}</span></div>`;
  }

  private async renderPipelineTab(): Promise<void> {
    const params = new URLSearchParams();
    if (this.filterMinScore) params.set('min_score', this.filterMinScore);
    if (this.filterFit) params.set('fit', this.filterFit);
    if (this.filterQuery) params.set('q', this.filterQuery);
    const qs = params.toString();

    const [data, profilesData] = await Promise.all([
      this.fetchJsonSafe<{ jobs?: SavedJob[] }>(`/api/jobs${qs ? `?${qs}` : ''}`, {
        method: 'GET',
      }),
      this.fetchJsonSafe<{ profiles?: SearchProfileEntry[] }>('/api/search-profiles', {
        method: 'GET',
      }),
    ]);

    const profiles = profilesData?.profiles ?? [];
    let jobs = data?.jobs ?? [];
    // Client-side filter reinforcement in case backend doesn't filter all query params yet
    if (this.filterMinScore) {
      const min = Number.parseFloat(this.filterMinScore);
      if (Number.isFinite(min)) {
        jobs = jobs.filter((j) => (j.score ?? 0) >= min);
      }
    }
    if (this.filterFit) {
      jobs = jobs.filter((j) => (j.fit_label ?? '').toLowerCase() === this.filterFit.toLowerCase());
    }
    if (this.filterQuery) {
      const q = this.filterQuery.toLowerCase();
      jobs = jobs.filter((j) => {
        const title = (j.job_title ?? '').toLowerCase();
        const desc = (j.job_description ?? '').toLowerCase();
        const rawSkills = Array.isArray(j.skills) ? j.skills.join(', ') : (j.skills ?? '');
        const skills = String(rawSkills).toLowerCase();
        return title.includes(q) || desc.includes(q) || skills.includes(q);
      });
    }

    const cardsHtml =
      jobs.length === 0
        ? '<p class="empty-state">No matching jobs in pipeline yet. Browse Upwork or trigger a search.</p>'
        : jobs
            .map((job) => {
              const safeUrl = sanitizeHttpUrl(job.canonical_url ?? job.url ?? '');
              const scoreText = typeof job.score === 'number' ? `${Math.round(job.score)}` : '--';
              const verifiedBadge =
                job.payment_verified === true
                  ? 'Verified'
                  : job.payment_verified === false
                    ? 'Unverified'
                    : '';
              const connectsText =
                typeof job.connects_required === 'number'
                  ? `${job.connects_required} Connects`
                  : '';
              const aiBadge = this.formatSidePanelAiBadge(job);
              const enrichTargetUrl = safeUrl ?? '';
              return `
                <article class="sp-card" data-job-id="${escapeHtml(String(job.id))}">
                  <div class="sp-card-header">
                    <h4>${escapeHtml(job.job_title ?? '')}</h4>
                    <span class="score-pill">${escapeHtml(scoreText)} ${escapeHtml(job.fit_label ?? '')}</span>
                  </div>
                  <div class="sp-meta">
                    <span>${escapeHtml(job.budget || 'Budget N/A')}</span>
                    ${job.hours_per_week ? `<span>${escapeHtml(job.hours_per_week)}</span>` : ''}
                    ${job.proposals_tier ? `<span>${escapeHtml(job.proposals_tier)}</span>` : ''}
                    ${connectsText ? `<span>${escapeHtml(connectsText)}</span>` : ''}
                    ${verifiedBadge ? `<span>${escapeHtml(verifiedBadge)}</span>` : ''}
                    ${job.client_spent ? `<span>${escapeHtml(job.client_spent)}</span>` : ''}
                    ${job.posted_text ? `<span>${escapeHtml(job.posted_text)}</span>` : ''}
                    ${job.client_country ? `<span>${escapeHtml(job.client_country)}</span>` : ''}
                    <span class="sp-badge badge-tag" data-testid="sp-ai-badge" data-ai-status="${escapeHtml(aiBadge.status)}">${escapeHtml(aiBadge.label)}</span>
                  </div>
                  <div class="sp-card-actions">
                    ${safeUrl ? `<a class="sp-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">Open on Upwork</a>` : ''}
                    <button type="button" class="btn-small js-view-job" data-job-id="${escapeHtml(String(job.id))}">Details</button>
                    ${
                      enrichTargetUrl || job.upwork_job_id
                        ? `<button type="button" class="btn-small js-enrich-job" data-testid="enrich-job-btn" data-job-id="${escapeHtml(String(job.id))}" data-job-url="${escapeHtml(enrichTargetUrl)}" data-upwork-id="${escapeHtml(job.upwork_job_id ?? '')}">Enrich</button>`
                        : ''
                    }
                  </div>
                </article>
              `;
            })
            .join('');

    const profileOptionsHtml = profiles
      .map(
        (p) =>
          `<option value="${escapeHtml(String(p.id))}">${escapeHtml(p.name)} (${escapeHtml(p.config?.search?.mode ?? 'live_search')})</option>`,
      )
      .join('');

    if (this.activeTab !== 'pipeline') return;

    this.els.contentEl.innerHTML = `
      <section class="sp-panel" data-testid="panel-pipeline">
        <div class="sp-search-bar" id="sp-search-bar">
          <input type="text" id="sp-search-query" data-testid="search-query-input" placeholder="Search Upwork query..." value="${escapeHtml(this.searchQueryInput)}" />
          <select id="sp-search-source" data-testid="search-source-select">
            <option value="search" ${this.searchSourceInput === 'search' ? 'selected' : ''}>Search</option>
            <option value="best_matches" ${this.searchSourceInput === 'best_matches' ? 'selected' : ''}>Best Matches</option>
            <option value="most_recent" ${this.searchSourceInput === 'most_recent' ? 'selected' : ''}>Most Recent</option>
            <option value="saved_jobs" ${this.searchSourceInput === 'saved_jobs' ? 'selected' : ''}>Saved Jobs</option>
          </select>
          <select id="sp-search-contract" data-testid="search-contract-select">
            <option value="" ${this.searchContractInput === '' ? 'selected' : ''}>Any Type</option>
            <option value="hourly" ${this.searchContractInput === 'hourly' ? 'selected' : ''}>Hourly</option>
            <option value="fixed" ${this.searchContractInput === 'fixed' ? 'selected' : ''}>Fixed</option>
          </select>
          <input type="number" id="sp-search-max-pages" min="1" max="20" title="Max pages" value="${escapeHtml(this.searchMaxPagesInput)}" />
          <input type="number" id="sp-search-enrich-n" min="0" max="50" title="Enrich top N" value="${escapeHtml(this.searchEnrichTopNInput)}" />
          <button type="button" id="sp-run-search-btn" data-testid="run-search-btn" class="btn-primary">Run Search</button>
          <button type="button" id="sp-save-profile-btn" data-testid="save-profile-btn" class="btn-secondary">Save Profile</button>
        </div>
        <div class="sp-toolbar">
          <select id="sp-profile-select" data-testid="search-profile-select">
            <option value="">Saved Profiles (${profiles.length})</option>
            ${profileOptionsHtml}
          </select>
          <button type="button" id="sp-run-profile-btn" data-testid="run-profile-btn" class="btn-secondary">Run Profile</button>
        </div>
        <p id="sp-search-status" class="sp-meta">${escapeHtml(this.searchStatusMessage)}</p>
        ${this.renderWatchersSummaryHtml()}
        <div class="sp-toolbar">
          <input type="number" data-testid="filter-min-score" id="sp-filter-min-score" placeholder="Min Score" value="${escapeHtml(this.filterMinScore)}" />
          <select data-testid="filter-fit" id="sp-filter-fit">
            <option value="">All Fits</option>
            <option value="hot" ${this.filterFit === 'hot' ? 'selected' : ''}>Hot (>=80)</option>
            <option value="ready" ${this.filterFit === 'ready' ? 'selected' : ''}>Ready (60-79)</option>
            <option value="review" ${this.filterFit === 'review' ? 'selected' : ''}>Review (40-59)</option>
            <option value="skip" ${this.filterFit === 'skip' ? 'selected' : ''}>Skip (&lt;40)</option>
          </select>
          <input type="search" data-testid="filter-query" id="sp-filter-query" placeholder="Search jobs..." value="${escapeHtml(this.filterQuery)}" />
          <button type="button" id="sp-pipeline-refresh" class="btn-secondary">Refresh</button>
          <button type="button" id="sp-analyze-tab" data-testid="analyze-current-tab-btn" class="btn-primary">Analyze Current Tab</button>
          <button type="button" id="sp-open-full-table" data-testid="open-full-table-btn" class="btn-secondary">Open Full Table ↗</button>
        </div>
        <div class="sp-list">${cardsHtml}</div>
        <div id="sp-job-detail-view"></div>
      </section>
    `;

    const minInput = this.els.contentEl.querySelector<HTMLInputElement>('#sp-filter-min-score');
    const fitSelect = this.els.contentEl.querySelector<HTMLSelectElement>('#sp-filter-fit');
    const queryInput = this.els.contentEl.querySelector<HTMLInputElement>('#sp-filter-query');
    const refreshBtn = this.els.contentEl.querySelector<HTMLButtonElement>('#sp-pipeline-refresh');
    const analyzeTabBtn = this.els.contentEl.querySelector<HTMLButtonElement>('#sp-analyze-tab');
    const openFullTableBtn =
      this.els.contentEl.querySelector<HTMLButtonElement>('#sp-open-full-table');

    const searchQueryEl = this.els.contentEl.querySelector<HTMLInputElement>('#sp-search-query');
    const searchSourceEl = this.els.contentEl.querySelector<HTMLSelectElement>('#sp-search-source');
    const searchContractEl =
      this.els.contentEl.querySelector<HTMLSelectElement>('#sp-search-contract');
    const searchMaxPagesEl =
      this.els.contentEl.querySelector<HTMLInputElement>('#sp-search-max-pages');
    const searchEnrichEl =
      this.els.contentEl.querySelector<HTMLInputElement>('#sp-search-enrich-n');
    const runSearchBtn = this.els.contentEl.querySelector<HTMLButtonElement>('#sp-run-search-btn');
    const saveProfileBtn =
      this.els.contentEl.querySelector<HTMLButtonElement>('#sp-save-profile-btn');
    const profileSelectEl =
      this.els.contentEl.querySelector<HTMLSelectElement>('#sp-profile-select');
    const runProfileBtn =
      this.els.contentEl.querySelector<HTMLButtonElement>('#sp-run-profile-btn');
    const searchStatusEl = this.els.contentEl.querySelector<HTMLElement>('#sp-search-status');

    const syncSearchInputs = () => {
      this.searchQueryInput = searchQueryEl?.value ?? '';
      this.searchSourceInput = (searchSourceEl?.value ?? 'search') as typeof this.searchSourceInput;
      this.searchContractInput = (searchContractEl?.value ?? '') as typeof this.searchContractInput;
      this.searchMaxPagesInput = searchMaxPagesEl?.value || '1';
      this.searchEnrichTopNInput = searchEnrichEl?.value || '0';
    };

    const setSearchStatus = (msg: string) => {
      this.searchStatusMessage = msg;
      if (searchStatusEl) {
        searchStatusEl.textContent = msg;
      }
    };

    runSearchBtn?.addEventListener('click', async () => {
      syncSearchInputs();
      runSearchBtn.disabled = true;
      setSearchStatus('Running Upwork search...');
      try {
        const payload = {
          source: this.searchSourceInput,
          query: this.searchQueryInput.trim() || undefined,
          contract_type: this.searchContractInput || undefined,
          max_pages: Math.max(1, Number.parseInt(this.searchMaxPagesInput, 10) || 1),
          enrich_top_n: Math.max(0, Number.parseInt(this.searchEnrichTopNInput, 10) || 0),
        };
        const res = await this.proxyTransport('/api/jobs/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          error_code?: string;
          jobs?: unknown[];
          stopped_reason?: string;
        };
        if (!res.ok) {
          setSearchStatus(
            body.error_code === 'HUMAN_ACTION_REQUIRED'
              ? `HUMAN_ACTION_REQUIRED: ${body.error ?? 'Resolve challenge in Chrome'}`
              : (body.error ?? `Search failed (${res.status})`),
          );
          return;
        }
        setSearchStatus(
          `Search complete: ${body.jobs?.length ?? 0} jobs (${body.stopped_reason ?? 'done'})`,
        );
        await this.renderPipelineTab();
      } catch (err) {
        setSearchStatus(err instanceof Error ? err.message : 'Search failed');
      } finally {
        runSearchBtn.disabled = false;
      }
    });

    saveProfileBtn?.addEventListener('click', async () => {
      syncSearchInputs();
      const q = this.searchQueryInput.trim() || this.searchSourceInput;
      const mode = this.searchSourceInput === 'search' ? 'live_search' : this.searchSourceInput;
      const name = `${mode}_${q
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .slice(0, 32)}`;
      const res = await this.proxyTransport('/api/search-profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: `Saved from Side Panel (${mode})`,
          config: {
            search: {
              mode,
              query: this.searchQueryInput.trim(),
              contract_type: this.searchContractInput || null,
              max_pages: Math.max(1, Number.parseInt(this.searchMaxPagesInput, 10) || 1),
            },
            enrichment: {
              enabled: (Number.parseInt(this.searchEnrichTopNInput, 10) || 0) > 0,
              max_jobs_to_enrich:
                Math.max(0, Number.parseInt(this.searchEnrichTopNInput, 10) || 0) || null,
            },
          },
        }),
      });
      if (res.ok) {
        setSearchStatus(`Saved profile "${name}"`);
        await this.renderPipelineTab();
      } else {
        setSearchStatus(`Failed to save profile (${res.status})`);
      }
    });

    runProfileBtn?.addEventListener('click', async () => {
      const profileId = profileSelectEl?.value;
      if (!profileId) {
        setSearchStatus('Select a saved search profile first');
        return;
      }
      runProfileBtn.disabled = true;
      setSearchStatus(`Running profile #${profileId}...`);
      try {
        const res = await this.proxyTransport(
          `/api/search-profiles/${encodeURIComponent(profileId)}/run`,
          { method: 'POST' },
        );
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          error_code?: string;
          jobs?: unknown[];
          stopped_reason?: string;
        };
        if (!res.ok) {
          setSearchStatus(
            body.error_code === 'HUMAN_ACTION_REQUIRED'
              ? `HUMAN_ACTION_REQUIRED: ${body.error ?? 'Resolve challenge in Chrome'}`
              : (body.error ?? `Profile run failed (${res.status})`),
          );
          return;
        }
        setSearchStatus(
          `Profile run complete: ${body.jobs?.length ?? 0} jobs (${body.stopped_reason ?? 'done'})`,
        );
        await this.renderPipelineTab();
      } catch (err) {
        setSearchStatus(err instanceof Error ? err.message : 'Profile run failed');
      } finally {
        runProfileBtn.disabled = false;
      }
    });

    const applyFilters = () => {
      this.filterMinScore = minInput?.value ?? '';
      this.filterFit = fitSelect?.value ?? '';
      this.filterQuery = queryInput?.value ?? '';
      void this.renderPipelineTab();
    };

    fitSelect?.addEventListener('change', applyFilters);
    refreshBtn?.addEventListener('click', applyFilters);
    minInput?.addEventListener('change', applyFilters);
    queryInput?.addEventListener('change', applyFilters);

    analyzeTabBtn?.addEventListener('click', async () => {
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (tabId !== undefined) {
          await browser.tabs.sendMessage(tabId, {
            type: 'CONTENT_EXTRACT_AND_ANALYZE',
            action: 'analyze',
          });
        }
      } catch {
        // ignore if active tab is not Upwork
      }
    });

    openFullTableBtn?.addEventListener('click', async () => {
      try {
        const res = (await browser.runtime.sendMessage({
          type: 'OPEN_JOBS_DASHBOARD',
          ...(this.filterFit ? { fit: this.filterFit } : {}),
          ...(this.filterQuery ? { q: this.filterQuery } : {}),
        })) as { ok?: boolean } | undefined;
        if (res?.ok) return;
      } catch {
        // fall back to direct tab creation
      }
      const params = new URLSearchParams();
      if (this.filterFit) params.set('fit', this.filterFit);
      if (this.filterQuery) params.set('q', this.filterQuery);
      const qs = params.toString();
      const baseUrl = browser.runtime.getURL('/dashboard.html');
      await browser.tabs.create({ url: qs ? `${baseUrl}?${qs}` : baseUrl });
    });

    this.els.contentEl.querySelectorAll<HTMLButtonElement>('.js-enrich-job').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const jobUrl = btn.dataset.jobUrl;
        const upworkId = btn.dataset.upworkId;
        btn.disabled = true;
        setSearchStatus('Enriching job details...');
        try {
          const res = await this.proxyTransport('/api/jobs/detail', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ...(jobUrl ? { url: jobUrl } : {}),
              ...(upworkId ? { upwork_job_id: upworkId } : {}),
            }),
          });
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            error_code?: string;
          };
          if (!res.ok) {
            setSearchStatus(
              body.error_code === 'HUMAN_ACTION_REQUIRED'
                ? `HUMAN_ACTION_REQUIRED: ${body.error ?? 'Resolve challenge in Chrome'}`
                : (body.error ?? `Enrich failed (${res.status})`),
            );
            return;
          }
          setSearchStatus('Job detail enrichment complete');
          await this.renderPipelineTab();
        } catch (err) {
          setSearchStatus(err instanceof Error ? err.message : 'Enrich failed');
        } finally {
          btn.disabled = false;
        }
      });
    });

    this.els.contentEl.querySelectorAll<HTMLButtonElement>('.js-view-job').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.jobId);
        const found = jobs.find((j) => j.id === id);
        const detailEl = this.els.contentEl.querySelector<HTMLElement>('#sp-job-detail-view');
        if (found && detailEl) {
          detailEl.innerHTML = `
            <div class="sp-detail-box">
              <h4>${escapeHtml(found.job_title ?? '')}</h4>
              <p>${escapeHtml(found.job_description ?? '')}</p>
              ${this.renderJobDetailV2Sections(found)}
              ${renderAnalysis({ proposal: found.proposal, time_estimate: found.time_estimate, execution_prompt: found.execution_prompt, tone_analysis: found.tone_analysis }, true)}
            </div>
          `;
          attachCollapsibleListeners(detailEl);
        }
      });
    });
  }

  private parseVerificationSnapshot(
    raw: ProposalRow['verification_snapshot_json'],
  ): ProposalSnapshotView | null {
    if (!raw) return null;
    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw) as ProposalSnapshotView;
      } catch {
        return null;
      }
    }
    return raw;
  }

  private renderSnapshotHtml(p: ProposalRow): string {
    const snap = this.parseVerificationSnapshot(p.verification_snapshot_json);
    if (!snap) return '';
    const details: string[] = [];
    if (typeof snap.cover_letter_length === 'number') {
      details.push(`Cover letter: ${snap.cover_letter_length} chars`);
    }
    if (snap.estimated_fee != null || snap.estimated_net != null) {
      const feeStr =
        typeof snap.estimated_fee === 'number' && Number.isFinite(snap.estimated_fee)
          ? `$${snap.estimated_fee}`
          : escapeHtml(String(snap.estimated_fee ?? '--'));
      const netStr =
        typeof snap.estimated_net === 'number' && Number.isFinite(snap.estimated_net)
          ? `$${snap.estimated_net}`
          : escapeHtml(String(snap.estimated_net ?? '--'));
      details.push(
        `Fee: ${snap.estimated_fee != null ? feeStr : '--'} / Net: ${snap.estimated_net != null ? netStr : '--'}`,
      );
    }
    if (snap.rate_increase || p.rate_increase) {
      details.push(`Rate increase: ${escapeHtml(String(snap.rate_increase ?? p.rate_increase))}`);
    }
    if (
      typeof snap.unanswered_required_questions === 'number' &&
      snap.unanswered_required_questions > 0
    ) {
      details.push(
        `<strong style="color:#991b1b">${snap.unanswered_required_questions} required screening question(s) unanswered</strong>`,
      );
    }
    const qaHtml =
      snap.screening_answers && snap.screening_answers.length > 0
        ? `<ul class="sp-snapshot-qa">${snap.screening_answers
            .map(
              (qa) =>
                `<li><strong>${escapeHtml(qa.prompt ?? 'Question')}${qa.required ? ' *' : ''}:</strong> ${escapeHtml(qa.answer ?? '(unanswered)')}</li>`,
            )
            .join('')}</ul>`
        : '';

    if (details.length === 0 && !qaHtml) return '';
    return `<div class="sp-v2-block">${details.length > 0 ? `<div class="sp-meta">${details.map((d) => `<span>${d}</span>`).join('')}</div>` : ''}${qaHtml}</div>`;
  }

  private async extractErrorMessage(res: Response, fallback: string): Promise<string> {
    try {
      const body = (await res.json()) as { error?: string; error_code?: string; message?: string };
      return body.error ?? body.message ?? body.error_code ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async renderApprovalsTab(): Promise<void> {
    const [propData, draftData] = await Promise.all([
      this.fetchJsonSafe<{ proposals?: ProposalRow[] }>('/api/proposals?status=pending_approval', {
        method: 'GET',
      }),
      this.fetchJsonSafe<{ drafts?: MessageDraftRow[] }>(
        '/api/messages/drafts?status=pending_approval',
        { method: 'GET' },
      ),
    ]);
    const proposals = propData?.proposals ?? [];
    const drafts = draftData?.drafts ?? [];
    const totalPending = proposals.length + drafts.length;

    this.els.approvalsBadge.textContent = String(totalPending);
    void browser.runtime
      .sendMessage({ type: 'BG_SET_PENDING_APPROVALS', count: totalPending })
      .catch(() => undefined);

    const statusBannerHtml = this.approvalsStatusMessage
      ? `<div id="sp-approvals-status" data-testid="approvals-status" class="sp-status-banner" data-level="${this.approvalsStatusError ? 'error' : 'ok'}">${escapeHtml(this.approvalsStatusMessage)}</div>`
      : '<div id="sp-approvals-status" data-testid="approvals-status"></div>';

    const proposalCardsHtml = proposals
      .map((p) => {
        const connects = p.total_connects ?? (p.connects_required ?? 0) + (p.boost_connects ?? 0);
        const snap = this.parseVerificationSnapshot(p.verification_snapshot_json) as
          | (ProposalSnapshotView & { triggered_by?: string })
          | null;
        const isWatcher = p.source === 'watcher' || snap?.triggered_by === 'watcher';
        return `
          <article class="sp-card" data-proposal-id="${escapeHtml(String(p.id))}">
            <div class="sp-card-header">
              <h4>${escapeHtml(p.job_title || p.upwork_job_id || `Proposal #${p.id}`)}</h4>
              <span class="score-pill">${escapeHtml(String(connects))} Connects</span>
            </div>
            <div class="sp-meta">
              <span>Bid: ${escapeHtml(p.bid_type ?? '')} ${escapeHtml(p.bid_amount != null ? `$${p.bid_amount}` : '')}</span>
              <span>Status: ${escapeHtml(p.status ?? 'pending_approval')}</span>
              ${isWatcher ? '<span class="badge-tag" data-testid="proposal-watcher-badge">Watcher</span>' : ''}
            </div>
            <p class="sp-preview">${escapeHtml((p.cover_letter ?? '').slice(0, 280))}</p>
            ${this.renderSnapshotHtml(p)}
            <div class="sp-card-actions">
              <button type="button" class="btn-primary js-approve-proposal" data-testid="approve-submit-btn" data-id="${escapeHtml(String(p.id))}">Approve &amp; Submit</button>
              <button type="button" class="btn-danger js-reject-proposal" data-testid="reject-proposal-btn" data-id="${escapeHtml(String(p.id))}">Reject</button>
            </div>
          </article>
        `;
      })
      .join('');

    const draftCardsHtml = drafts
      .map((d) => {
        const roomId = d.upwork_room_id ?? d.room_id ?? '';
        return `
          <article class="sp-card" data-draft-id="${escapeHtml(String(d.id))}" data-room-id="${escapeHtml(roomId)}">
            <div class="sp-card-header">
              <h4>Reply: ${escapeHtml(d.client_name || roomId || `Draft #${d.id}`)}</h4>
              <span class="score-pill">Message Draft</span>
            </div>
            ${d.job_title ? `<div class="sp-meta"><span>${escapeHtml(d.job_title)}</span></div>` : ''}
            <p class="sp-preview">${escapeHtml(d.body)}</p>
            <div class="sp-card-actions">
              <button type="button" class="btn-primary js-approve-msg-draft" data-testid="approve-send-btn" data-id="${escapeHtml(String(d.id))}" data-room-id="${escapeHtml(roomId)}">Approve &amp; Send</button>
              <button type="button" class="btn-danger js-reject-msg-draft" data-testid="reject-message-btn" data-id="${escapeHtml(String(d.id))}">Reject</button>
            </div>
          </article>
        `;
      })
      .join('');

    const listHtml =
      totalPending === 0
        ? '<p class="empty-state">No pending approvals. Proposals and messages awaiting confirmation appear here.</p>'
        : `${proposalCardsHtml}${draftCardsHtml}`;

    if (this.activeTab !== 'approvals') return;

    this.els.contentEl.innerHTML = `
      <section class="sp-panel" data-testid="panel-approvals">
        <div class="sp-toolbar">
          <h3>Pending Approvals (${totalPending})</h3>
          <button type="button" id="sp-approvals-refresh" class="btn-secondary">Refresh</button>
        </div>
        ${statusBannerHtml}
        <div class="sp-list">${listHtml}</div>
      </section>
    `;

    this.els.contentEl
      .querySelector('#sp-approvals-refresh')
      ?.addEventListener('click', () => void this.renderApprovalsTab());

    this.els.contentEl
      .querySelectorAll<HTMLButtonElement>('.js-approve-proposal')
      .forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          if (!id) return;
          btn.disabled = true;
          try {
            const res = await this.proxyTransport(
              `/api/proposals/${encodeURIComponent(id)}/approve`,
              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
            );
            if (!res.ok) {
              this.approvalsStatusError = true;
              this.approvalsStatusMessage = await this.extractErrorMessage(
                res,
                `Approval failed (${res.status})`,
              );
              await this.renderApprovalsTab();
              return;
            }
            this.approvalsStatusError = false;
            this.approvalsStatusMessage = `Proposal #${id} submitted successfully.`;
            await this.refreshHeaderStatus();
            await this.renderApprovalsTab();
          } catch (err) {
            this.approvalsStatusError = true;
            this.approvalsStatusMessage = err instanceof Error ? err.message : 'Approval failed';
            await this.renderApprovalsTab();
          }
        });
      });

    this.els.contentEl.querySelectorAll<HTMLButtonElement>('.js-reject-proposal').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!id) return;
        const res = await this.proxyTransport(`/api/proposals/${encodeURIComponent(id)}/reject`, {
          method: 'POST',
        });
        if (!res.ok) {
          this.approvalsStatusError = true;
          this.approvalsStatusMessage = await this.extractErrorMessage(
            res,
            `Reject failed (${res.status})`,
          );
        } else {
          this.approvalsStatusError = false;
          this.approvalsStatusMessage = `Proposal #${id} rejected.`;
        }
        await this.refreshHeaderStatus();
        await this.renderApprovalsTab();
      });
    });

    this.els.contentEl
      .querySelectorAll<HTMLButtonElement>('.js-approve-msg-draft')
      .forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const roomId = btn.dataset.roomId ?? '';
          if (!id) return;
          btn.disabled = true;
          const res = await this.proxyTransport(`/api/messages/${encodeURIComponent(id)}/approve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          if (!res.ok) {
            this.approvalsStatusError = true;
            this.approvalsStatusMessage = await this.extractErrorMessage(
              res,
              `Send failed (${res.status})`,
            );
          } else {
            this.approvalsStatusError = false;
            this.approvalsStatusMessage = `Reply sent to ${roomId || `draft #${id}`}.`;
          }
          await this.refreshHeaderStatus();
          await this.renderApprovalsTab();
        });
      });

    this.els.contentEl
      .querySelectorAll<HTMLButtonElement>('.js-reject-msg-draft')
      .forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          if (!id) return;
          await this.proxyTransport(`/api/messages/${encodeURIComponent(id)}/reject`, {
            method: 'POST',
          });
          this.approvalsStatusError = false;
          this.approvalsStatusMessage = `Message draft #${id} rejected.`;
          await this.refreshHeaderStatus();
          await this.renderApprovalsTab();
        });
      });
  }

  private async renderMessagesTab(): Promise<void> {
    const [threadsData, draftsData] = await Promise.all([
      this.fetchJsonSafe<{ threads?: ThreadRow[] }>('/api/messages/threads', {
        method: 'GET',
      }),
      this.fetchJsonSafe<{ drafts?: MessageDraftRow[] }>(
        '/api/messages/drafts?status=pending_approval',
        { method: 'GET' },
      ),
    ]);
    const threads = threadsData?.threads ?? [];
    const pendingDrafts = draftsData?.drafts ?? [];
    const totalUnread = threads.reduce((sum, t) => sum + (t.unread_count || 0), 0);
    this.els.unreadBadge.textContent = String(totalUnread);

    const statusBannerHtml = this.messagesStatusMessage
      ? `<div id="sp-messages-status" data-testid="messages-status" class="sp-status-banner" data-level="${this.messagesStatusError ? 'error' : 'ok'}">${escapeHtml(this.messagesStatusMessage)}</div>`
      : '<div id="sp-messages-status" data-testid="messages-status"></div>';

    const pendingDraftsHtml =
      pendingDrafts.length > 0
        ? `
          <div class="sp-pending-drafts" data-testid="pending-reply-drafts">
            <h4>Pending Reply Approvals (${pendingDrafts.length})</h4>
            <div class="sp-list">
              ${pendingDrafts
                .map((d) => {
                  const roomId = d.upwork_room_id ?? d.room_id ?? '';
                  return `
                    <article class="sp-card" data-draft-id="${escapeHtml(String(d.id))}" data-room-id="${escapeHtml(roomId)}">
                      <div class="sp-card-header">
                        <h4>${escapeHtml(d.client_name || roomId)}</h4>
                        <span class="score-pill">Pending Approval</span>
                      </div>
                      ${d.job_title ? `<div class="sp-meta"><span>${escapeHtml(d.job_title)}</span></div>` : ''}
                      <p class="sp-preview">${escapeHtml(d.body)}</p>
                      <div class="sp-card-actions">
                        <button type="button" class="btn-primary js-approve-send-draft" data-testid="approve-send-btn" data-id="${escapeHtml(String(d.id))}" data-room-id="${escapeHtml(roomId)}">Approve &amp; Send</button>
                        <button type="button" class="btn-danger js-reject-send-draft" data-testid="reject-message-btn" data-id="${escapeHtml(String(d.id))}">Reject</button>
                      </div>
                    </article>
                  `;
                })
                .join('')}
            </div>
          </div>
        `
        : '';

    const listHtml =
      threads.length === 0
        ? '<p class="empty-state">No synced Upwork message threads yet.</p>'
        : threads
            .map(
              (t) => `
                <article class="sp-card" data-room-id="${escapeHtml(t.upwork_room_id)}" data-unread="${t.unread_count > 0 ? 'true' : 'false'}">
                  <div class="sp-card-header">
                    <h4>${escapeHtml(t.client_name || t.upwork_room_id)}</h4>
                    ${t.unread_count > 0 ? `<span class="score-pill">${escapeHtml(String(t.unread_count))} unread</span>` : ''}
                  </div>
                  <div class="sp-meta"><span>${escapeHtml(t.job_title ?? t.upwork_room_id)}</span></div>
                  <p class="sp-preview">${escapeHtml(t.last_message_snippet)}</p>
                  <div class="sp-card-actions">
                    <button type="button" class="btn-secondary js-open-thread" data-room-id="${escapeHtml(t.upwork_room_id)}">Open Thread</button>
                  </div>
                </article>
              `,
            )
            .join('');

    if (this.activeTab !== 'messages') return;

    this.els.contentEl.innerHTML = `
      <section class="sp-panel" data-testid="panel-messages">
        <div class="sp-toolbar">
          <h3>Client Messages</h3>
          <button type="button" id="sp-sync-threads-btn" data-testid="sync-threads-btn" class="btn-secondary">Sync Threads</button>
          <button type="button" id="sp-messages-refresh" class="btn-secondary">Refresh</button>
        </div>
        ${statusBannerHtml}
        ${pendingDraftsHtml}
        <div class="sp-list">${listHtml}</div>
        <div id="sp-thread-detail"></div>
      </section>
    `;

    this.els.contentEl
      .querySelector('#sp-messages-refresh')
      ?.addEventListener('click', () => void this.renderMessagesTab());

    this.els.contentEl
      .querySelector('#sp-sync-threads-btn')
      ?.addEventListener('click', async () => {
        const res = await this.proxyTransport('/api/messages/threads/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!res.ok) {
          this.messagesStatusError = true;
          this.messagesStatusMessage = await this.extractErrorMessage(
            res,
            `Sync failed (${res.status})`,
          );
        } else {
          this.messagesStatusError = false;
          this.messagesStatusMessage = 'Synced message threads.';
        }
        await this.refreshHeaderStatus();
        await this.renderMessagesTab();
      });

    this.els.contentEl
      .querySelectorAll<HTMLButtonElement>('.js-approve-send-draft')
      .forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          const roomId = btn.dataset.roomId ?? '';
          if (!id) return;
          btn.disabled = true;
          try {
            const res = await this.proxyTransport(
              `/api/messages/${encodeURIComponent(id)}/approve`,
              { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
            );
            if (!res.ok) {
              this.messagesStatusError = true;
              this.messagesStatusMessage = await this.extractErrorMessage(
                res,
                `Send failed (${res.status})`,
              );
            } else {
              this.messagesStatusError = false;
              this.messagesStatusMessage = `Message sent to ${roomId || `room #${id}`}.`;
            }
            await this.refreshHeaderStatus();
            await this.renderMessagesTab();
          } catch (err) {
            this.messagesStatusError = true;
            this.messagesStatusMessage = err instanceof Error ? err.message : 'Send failed';
            await this.renderMessagesTab();
          }
        });
      });

    this.els.contentEl
      .querySelectorAll<HTMLButtonElement>('.js-reject-send-draft')
      .forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = btn.dataset.id;
          if (!id) return;
          await this.proxyTransport(`/api/messages/${encodeURIComponent(id)}/reject`, {
            method: 'POST',
          });
          this.messagesStatusError = false;
          this.messagesStatusMessage = `Draft #${id} rejected.`;
          await this.refreshHeaderStatus();
          await this.renderMessagesTab();
        });
      });

    this.els.contentEl.querySelectorAll<HTMLButtonElement>('.js-open-thread').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const roomId = btn.dataset.roomId;
        if (!roomId) return;
        const detailEl = this.els.contentEl.querySelector<HTMLElement>('#sp-thread-detail');
        if (!detailEl) return;
        const threadData = await this.fetchJsonSafe<{
          messages?: Array<{ sender: string; body: string; is_draft?: boolean; id?: number }>;
        }>(`/api/messages/threads/${encodeURIComponent(roomId)}`, { method: 'GET' });
        const messages = threadData?.messages ?? [];
        detailEl.innerHTML = `
          <div class="sp-detail-box">
            <h4>Room ${escapeHtml(roomId)}</h4>
            ${messages
              .map((m) => `<p><strong>${escapeHtml(m.sender)}:</strong> ${escapeHtml(m.body)}</p>`)
              .join('')}
            <textarea id="sp-reply-draft" rows="3" placeholder="Draft reply..."></textarea>
            <div class="sp-card-actions">
              <button type="button" id="sp-save-draft-btn" data-testid="save-reply-draft-btn" class="btn-secondary">Save Draft</button>
              <button type="button" id="sp-send-manual-reply-btn" data-testid="send-manual-reply-btn" class="btn-primary">Draft &amp; Approve Send</button>
            </div>
          </div>
        `;

        detailEl.querySelector('#sp-save-draft-btn')?.addEventListener('click', async () => {
          const text = detailEl.querySelector<HTMLTextAreaElement>('#sp-reply-draft')?.value ?? '';
          const res = await this.proxyTransport(
            `/api/messages/threads/${encodeURIComponent(roomId)}/draft`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ body: text, prefill_composer: true }),
            },
          );
          if (!res.ok) {
            this.messagesStatusError = true;
            this.messagesStatusMessage = await this.extractErrorMessage(
              res,
              `Draft failed (${res.status})`,
            );
          } else {
            this.messagesStatusError = false;
            this.messagesStatusMessage = `Saved draft for ${roomId}.`;
          }
          await this.refreshHeaderStatus();
          await this.renderMessagesTab();
        });

        detailEl.querySelector('#sp-send-manual-reply-btn')?.addEventListener('click', async () => {
          const text = detailEl.querySelector<HTMLTextAreaElement>('#sp-reply-draft')?.value ?? '';
          const draftRes = await this.proxyTransport(
            `/api/messages/threads/${encodeURIComponent(roomId)}/draft`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ body: text, prefill_composer: false }),
            },
          );
          if (!draftRes.ok) {
            this.messagesStatusError = true;
            this.messagesStatusMessage = await this.extractErrorMessage(
              draftRes,
              `Draft failed (${draftRes.status})`,
            );
            await this.renderMessagesTab();
            return;
          }
          const draftJson = (await draftRes.json().catch(() => ({}))) as {
            message?: { id?: number };
          };
          const draftId = draftJson.message?.id;
          if (!draftId) {
            this.messagesStatusError = true;
            this.messagesStatusMessage = 'Draft created without message ID';
            await this.renderMessagesTab();
            return;
          }
          const appRes = await this.proxyTransport(
            `/api/messages/${encodeURIComponent(String(draftId))}/approve`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
          );
          if (!appRes.ok) {
            this.messagesStatusError = true;
            this.messagesStatusMessage = await this.extractErrorMessage(
              appRes,
              `Send failed (${appRes.status})`,
            );
          } else {
            this.messagesStatusError = false;
            this.messagesStatusMessage = `Message sent to ${roomId}.`;
          }
          await this.refreshHeaderStatus();
          await this.renderMessagesTab();
        });
      });
    });
  }

  private async renderActivityTab(): Promise<void> {
    const [runtime, policy, auditData] = await Promise.all([
      this.refreshHeaderStatus(),
      this.fetchJsonSafe<PolicySnapshot>('/api/policy', { method: 'GET' }),
      this.fetchJsonSafe<{ logs?: AuditLogRow[] }>('/api/audit-logs?limit=20', { method: 'GET' }),
    ]);

    const mode = policy?.mode ?? runtime?.policyMode ?? 'confirm_in_ui';
    const maxProp = policy?.max_proposals_per_day ?? 5;
    const maxConn = policy?.max_connects_per_day ?? 50;
    const maxMsg = policy?.max_messages_per_day ?? 20;
    const minScore = policy?.min_job_score ?? 0;

    const propRatio = `${policy?.proposals_today ?? 0} / ${maxProp}`;
    const connRatio = `${policy?.connects_today ?? 0} / ${maxConn}`;
    const msgRatio = `${policy?.messages_today ?? 0} / ${maxMsg}`;

    const policyBannerHtml = this.policyStatusMessage
      ? `<div id="sp-policy-status" class="sp-status-banner" data-level="${this.policyStatusError ? 'error' : 'ok'}">${escapeHtml(this.policyStatusMessage)}</div>`
      : '<div id="sp-policy-status"></div>';

    const activityRows = (runtime?.recentActivity ?? [])
      .map(
        (entry) => `
          <li>
            <span class="badge-tag">${escapeHtml(entry.source)}</span>
            <strong>${escapeHtml(entry.action)}</strong> — ${escapeHtml(entry.detail)}
          </li>
        `,
      )
      .join('');

    const auditRows = (auditData?.logs ?? [])
      .map(
        (row) => `
          <li>
            <strong>${escapeHtml(row.action_type ?? '')}</strong> (${escapeHtml(row.actor ?? '')}): ${escapeHtml(row.outcome ?? '')}
            ${row.created_at ? `<small>${escapeHtml(row.created_at)}</small>` : ''}
          </li>
        `,
      )
      .join('');

    if (this.activeTab !== 'activity') return;

    this.els.contentEl.innerHTML = `
      <section class="sp-panel" data-testid="panel-activity">
        <div class="sp-card">
          <div class="sp-card-header">
            <h4>Policy Mode: ${escapeHtml(mode)}</h4>
            <button type="button" id="sp-activity-kill-switch" data-testid="kill-switch-btn" class="btn-danger">Kill Switch</button>
          </div>
          <div class="budget-grid">
            <div><span class="label">Proposals Today</span><strong>${escapeHtml(propRatio)}</strong></div>
            <div><span class="label">Connects Today</span><strong>${escapeHtml(connRatio)}</strong></div>
            <div><span class="label">Messages Today</span><strong>${escapeHtml(msgRatio)}</strong></div>
          </div>
          ${this.renderWatchersSummaryHtml()}
          <div class="sp-toolbar" style="margin-top:10px">
            <select id="sp-policy-mode" data-testid="policy-mode-select">
              <option value="confirm_in_ui" ${mode === 'confirm_in_ui' ? 'selected' : ''}>confirm_in_ui</option>
              <option value="draft_only" ${mode === 'draft_only' ? 'selected' : ''}>draft_only</option>
              <option value="auto_with_guardrails" ${mode === 'auto_with_guardrails' ? 'selected' : ''}>auto_with_guardrails</option>
            </select>
            <input type="number" id="sp-cap-proposals" min="0" title="Max proposals/day" value="${escapeHtml(String(maxProp))}" />
            <input type="number" id="sp-cap-connects" min="0" title="Max connects/day" value="${escapeHtml(String(maxConn))}" />
            <input type="number" id="sp-cap-messages" min="0" title="Max messages/day" value="${escapeHtml(String(maxMsg))}" />
            <input type="number" id="sp-min-job-score" min="0" max="100" title="Min job score" value="${escapeHtml(String(minScore))}" />
            <button type="button" id="sp-save-policy-btn" data-testid="save-policy-btn" class="btn-primary">Save Policy</button>
          </div>
          ${policyBannerHtml}
        </div>
        <h3>Live Extension Activity</h3>
        <ul class="sp-activity-list">${activityRows || '<li>No recent activity yet.</li>'}</ul>
        <h3>Audit Ledger</h3>
        <ul class="sp-activity-list">${auditRows || '<li>No audit records loaded.</li>'}</ul>
      </section>
    `;

    this.els.contentEl
      .querySelector('#sp-activity-kill-switch')
      ?.addEventListener('click', () => void this.triggerKillSwitch());

    this.els.contentEl.querySelector('#sp-save-policy-btn')?.addEventListener('click', async () => {
      const nextMode =
        this.els.contentEl.querySelector<HTMLSelectElement>('#sp-policy-mode')?.value ??
        'confirm_in_ui';
      const maxP = Number.parseInt(
        this.els.contentEl.querySelector<HTMLInputElement>('#sp-cap-proposals')?.value ?? '5',
        10,
      );
      const maxC = Number.parseInt(
        this.els.contentEl.querySelector<HTMLInputElement>('#sp-cap-connects')?.value ?? '50',
        10,
      );
      const maxM = Number.parseInt(
        this.els.contentEl.querySelector<HTMLInputElement>('#sp-cap-messages')?.value ?? '20',
        10,
      );
      const minS = Number.parseInt(
        this.els.contentEl.querySelector<HTMLInputElement>('#sp-min-job-score')?.value ?? '0',
        10,
      );

      const res = await this.proxyTransport('/api/policy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: nextMode,
          max_proposals_per_day: Number.isFinite(maxP) ? maxP : 5,
          max_connects_per_day: Number.isFinite(maxC) ? maxC : 50,
          max_messages_per_day: Number.isFinite(maxM) ? maxM : 20,
          min_job_score: Number.isFinite(minS) ? minS : 0,
        }),
      });
      if (!res.ok) {
        this.policyStatusError = true;
        this.policyStatusMessage = await this.extractErrorMessage(
          res,
          `Policy update failed (${res.status})`,
        );
      } else {
        this.policyStatusError = false;
        this.policyStatusMessage = `Policy saved (${nextMode}).`;
      }
      await this.refreshHeaderStatus();
      await this.renderActivityTab();
    });
  }

  private async renderAgentsTab(): Promise<void> {
    this.els.contentEl.innerHTML = `
      <section class="sp-panel" data-testid="panel-agents">
        <div class="subtabs">
          <button type="button" class="subtab-btn ${this.activeAgentsSubTab === 'profile' ? 'active' : ''}" data-subtab="profile">Profile</button>
          <button type="button" class="subtab-btn ${this.activeAgentsSubTab === 'cache' ? 'active' : ''}" data-subtab="cache">Analyzed Cache</button>
          <button type="button" class="subtab-btn ${this.activeAgentsSubTab === 'history' ? 'active' : ''}" data-subtab="history">Job History</button>
          <button type="button" class="subtab-btn ${this.activeAgentsSubTab === 'blueprints' ? 'active' : ''}" data-testid="tab-blueprints" data-subtab="blueprints">Agent Blueprints</button>
        </div>
        <div id="sp-agents-container"></div>
        <div id="sp-persisted-agents-summary"></div>
      </section>
    `;

    this.els.contentEl.querySelectorAll<HTMLButtonElement>('.subtab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const next = btn.dataset.subtab as typeof this.activeAgentsSubTab | undefined;
        if (next) {
          this.activeAgentsSubTab = next;
          void this.renderAgentsTab();
        }
      });
    });

    const container = this.els.contentEl.querySelector<HTMLDivElement>('#sp-agents-container');
    const summaryEl = this.els.contentEl.querySelector<HTMLDivElement>(
      '#sp-persisted-agents-summary',
    );
    if (!container) return;

    if (this.activeAgentsSubTab === 'blueprints') {
      await new TemplateBrowser(this.apiClient, container).render();
      return;
    }

    const agentsPromise = this.apiClient
      .listAgents()
      .then((res) => (Array.isArray(res?.agents) ? res.agents : []))
      .catch(() => [] as GeneratedAgent[]);

    if (this.activeAgentsSubTab === 'profile') {
      const [, persistedAgents] = await Promise.all([
        this.stateManager.loadProfile().catch(() => undefined),
        agentsPromise,
      ]);
      new ProfileConfigUI(this.stateManager, container).render();
      if (summaryEl) {
        this.renderPersistedAgentsSummary(summaryEl, persistedAgents);
      }
    } else if (this.activeAgentsSubTab === 'cache') {
      new ProjectsListUI(this.stateManager, container, this.els.root).render();
      const persistedAgents = await agentsPromise;
      if (summaryEl) {
        this.renderPersistedAgentsSummary(summaryEl, persistedAgents);
      }
    } else {
      const [jobs, persistedAgents] = await Promise.all([
        this.stateManager.loadSavedJobs().catch(() => []),
        agentsPromise,
      ]);
      const historyUI = new JobHistoryPanel(
        container,
        (job) => {
          container.innerHTML = `
            <button type="button" id="sp-history-back" class="btn-secondary">← Back</button>
            <h4>${escapeHtml(job.job_title ?? '')}</h4>
            ${renderAnalysis({ proposal: job.proposal, time_estimate: job.time_estimate, execution_prompt: job.execution_prompt, tone_analysis: job.tone_analysis }, true)}
          `;
          attachCollapsibleListeners(container);
          container
            .querySelector('#sp-history-back')
            ?.addEventListener('click', () => void this.renderAgentsTab());
        },
        async (id) => {
          await this.stateManager.deleteJobFromHistory(id);
          await this.renderAgentsTab();
        },
      );
      historyUI.render(jobs);
      if (summaryEl) {
        this.renderPersistedAgentsSummary(summaryEl, persistedAgents);
      }
    }
  }

  private renderPersistedAgentsSummary(container: HTMLElement, agents: GeneratedAgent[]): void {
    const cardsHtml =
      agents.length === 0
        ? '<p class="sp-meta">No generated agent blueprints saved yet.</p>'
        : `<div class="sp-list">${agents
            .map((agent, idx) => {
              const displayName = agent.blueprint_name || agent.file_name;
              const previewId = `sp-agent-preview-${idx}`;
              return `
                <article class="sp-card" data-testid="persisted-agent-card">
                  <div class="sp-card-header">
                    <h4>${escapeHtml(displayName)}</h4>
                    <span class="score-pill">${escapeHtml(agent.format)}</span>
                  </div>
                  <div class="sp-meta">
                    <span>Template: ${escapeHtml(agent.template_name)}</span>
                    <span>File: ${escapeHtml(agent.file_name)}</span>
                  </div>
                  <div class="sp-card-actions">
                    <button type="button" class="btn-secondary sp-agent-preview-btn" data-target="${previewId}">Preview</button>
                    <button type="button" class="btn-primary sp-agent-download-btn" data-testid="download-agent-zip-btn" data-index="${idx}">Download .zip</button>
                  </div>
                  <pre id="${previewId}" class="sp-preview" style="display:none; white-space:pre-wrap; max-height:200px; overflow:auto;">${escapeHtml(agent.content)}</pre>
                </article>
              `;
            })
            .join('')}</div>`;

    container.innerHTML = `
      <section class="sp-card" data-testid="persisted-agents-summary" style="margin-top: 12px;">
        <div class="sp-card-header">
          <h4>Generated Agent Blueprints (${agents.length})</h4>
          <button type="button" class="btn-secondary" data-testid="open-blueprints-btn">Open Blueprints</button>
        </div>
        ${cardsHtml}
      </section>
    `;

    container
      .querySelector('[data-testid="open-blueprints-btn"]')
      ?.addEventListener('click', () => {
        this.activeAgentsSubTab = 'blueprints';
        void this.renderAgentsTab();
      });

    container.querySelectorAll<HTMLButtonElement>('.sp-agent-preview-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const target = targetId
          ? container.querySelector<HTMLElement>(`[id="${targetId.replace(/"/g, '\\"')}"]`)
          : null;
        if (target) {
          target.style.display = target.style.display === 'none' ? 'block' : 'none';
        }
      });
    });

    container.querySelectorAll<HTMLButtonElement>('.sp-agent-download-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.index);
        const agent = agents[idx];
        if (!agent) return;
        const agentName = agent.blueprint_name || agent.file_name.replace(/\.(yaml|md)$/, '');
        void this.apiClient
          .downloadAgents([agentName], {
            template_name: agent.template_name,
            format: agent.format,
          })
          .then((blob) => {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${agentName}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          })
          .catch(() => undefined);
      });
    });
  }

  private renderAuditReportDetails(report: DriftAuditReport): string {
    const healthyCount = report.healthy_selectors_count ?? 0;
    const degradedCount = report.degraded_selectors_count ?? 0;
    const brokenCount = report.broken_selectors_count ?? 0;
    const fragileCount = report.fragile_selectors_count ?? 0;
    const breakingChanges = report.breaking_changes_detected ?? [];
    const audits = report.audits ?? [];
    const baselineDiffs = report.baseline_diffs ?? [];
    const discoveredCandidates = report.discovered_candidates ?? [];

    const countsLine = `Healthy: ${healthyCount} | Degraded: ${degradedCount} | Broken: ${brokenCount} | Fragile: ${fragileCount}`;

    const breakingHtml =
      breakingChanges.length > 0
        ? `<ul class="sp-alert-list">${breakingChanges
            .map((b) => `<li>${escapeHtml(b)}</li>`)
            .join('')}</ul>`
        : '';

    const rulesHtml = audits
      .map((entry) => {
        const sampleText = Array.isArray(entry.sample_extracted_value)
          ? entry.sample_extracted_value.join(', ')
          : entry.sample_extracted_value != null
            ? String(entry.sample_extracted_value)
            : '';
        const truncatedSample = sampleText.slice(0, 80);
        const info = entry.suggested_replacement
          ? `Suggested: ${entry.suggested_replacement}`
          : entry.notes;
        return `
          <li>
            <strong>${escapeHtml(entry.target_field)}</strong>
            [${escapeHtml(entry.status)} · ${escapeHtml(String(entry.matched_count))}]
            <code>${escapeHtml(entry.registered_selector)}</code>
            ${info ? `— ${escapeHtml(info)}` : ''}
            ${truncatedSample ? `<small>(${escapeHtml(truncatedSample)})</small>` : ''}
          </li>
        `;
      })
      .join('');

    const diffsHtml = baselineDiffs
      .map(
        (d) => `
          <li>
            <strong>${escapeHtml(d.hook_type)}:${escapeHtml(d.hook_name)}</strong>
            [${escapeHtml(d.change_type)}]
            ${escapeHtml(String(d.baseline_frequency))} → ${escapeHtml(String(d.current_frequency))}
          </li>
        `,
      )
      .join('');

    const discoveredHtml = discoveredCandidates
      .map(
        (c) => `
          <li>
            <strong>${escapeHtml(c.hook_name)}</strong>
            (${escapeHtml(c.confidence)})
            <code>${escapeHtml(c.suggested_selector)}</code>
            ${c.sample_text ? `— ${escapeHtml(c.sample_text.slice(0, 60))}` : ''}
          </li>
        `,
      )
      .join('');

    return `
      <div class="sp-meta"><span>${escapeHtml(countsLine)}</span></div>
      ${breakingHtml}
      <details>
        <summary>Selector Rules (${escapeHtml(String(audits.length))})</summary>
        <ul>${rulesHtml || '<li>None</li>'}</ul>
      </details>
      ${
        baselineDiffs.length > 0
          ? `<details><summary>Baseline Diffs (${escapeHtml(String(baselineDiffs.length))})</summary><ul>${diffsHtml}</ul></details>`
          : ''
      }
      ${
        discoveredCandidates.length > 0
          ? `<details><summary>Discovered Auth Fields (${escapeHtml(String(discoveredCandidates.length))})</summary><ul>${discoveredHtml}</ul></details>`
          : ''
      }
    `;
  }

  private inferPatchExtractMode(field: string): ExtractMode {
    const lower = field.toLowerCase();
    if (lower === 'skills' || lower === 'skill' || lower.includes('items')) return 'list';
    if (lower.includes('url') || lower === 'link') return 'attribute';
    if (lower.includes('description') || lower.includes('body')) return 'full_text';
    return 'text';
  }

  private renderBrokenFieldsInspector(): string {
    const detail = this.latestCaptureDetail;
    const captureUid = detail?.capture_uid ?? detail?.entry?.capture_uid ?? '';
    const brokenFields = detail?.capture?.broken_fields ?? detail?.entry?.broken_fields ?? [];
    if (!detail) {
      return `
        <div class="sp-section" data-testid="failing-fields-inspector">
          <h4>UI Diagnostic Workbench</h4>
          <p class="sp-meta">Click <strong>Capture Active Tab</strong> while viewing an Upwork job or drawer to capture pruned DOM context and candidate selectors.</p>
        </div>
      `;
    }
    if (brokenFields.length === 0) {
      return `
        <div class="sp-section" data-testid="failing-fields-inspector">
          <h4>UI Diagnostic Workbench</h4>
          <p class="sp-meta">Latest capture <code>${escapeHtml(captureUid)}</code> (${escapeHtml(detail.capture?.view_type ?? detail.entry?.view_type ?? '')}) found zero broken selectors.</p>
        </div>
      `;
    }

    const cardsHtml = brokenFields
      .map((bf, idx) => {
        const defaultSelector = bf.candidates[0]?.selector ?? '';
        const defaultExtract = this.inferPatchExtractMode(bf.field);
        const key = `${bf.view}:${bf.field}`;
        const feedback = this.patchTestFeedback.get(key) ?? '';
        const candidatesHtml =
          bf.candidates.length === 0
            ? '<span class="sp-meta">No automatic candidates found — inspect Anchor HTML below.</span>'
            : bf.candidates
                .slice(0, 6)
                .map((c) => {
                  const sampleStr = Array.isArray(c.sample_value)
                    ? c.sample_value.slice(0, 3).join(', ')
                    : String(c.sample_value ?? '');
                  return `
                    <button
                      type="button"
                      class="sp-candidate-chip"
                      data-idx="${idx}"
                      data-selector="${escapeHtml(c.selector)}"
                      title="${escapeHtml(c.reason)}${sampleStr ? ` | sample: ${escapeHtml(sampleStr)}` : ''}"
                    >
                      <code>${escapeHtml(c.selector)}</code>
                      <span>(${escapeHtml(String(c.stability_score))}, ${escapeHtml(String(c.matched_count))}x)</span>
                    </button>
                  `;
                })
                .join('');

        return `
          <article class="sp-card sp-broken-card" data-broken-idx="${idx}" data-field="${escapeHtml(bf.field)}" data-view="${escapeHtml(bf.view)}">
            <div class="sp-card-header">
              <h5>${escapeHtml(bf.view)}.${escapeHtml(bf.field)}</h5>
              <span class="score-pill">${escapeHtml(bf.status)}</span>
            </div>
            <div class="sp-meta">
              ${bf.nearest_heading ? `<span>Heading: ${escapeHtml(bf.nearest_heading)}</span>` : ''}
              <span>Current: <code>${escapeHtml(bf.registered_selector || '(none)')}</code></span>
            </div>
            ${bf.notes ? `<p class="sp-meta">${escapeHtml(bf.notes)}</p>` : ''}
            <div class="sp-candidate-list">${candidatesHtml}</div>
            <div class="sp-patch-row">
              <input
                type="text"
                class="sp-patch-input"
                id="sp-patch-input-${idx}"
                value="${escapeHtml(defaultSelector)}"
                placeholder="CSS selector to test & apply"
              />
              <select class="sp-patch-extract" id="sp-patch-extract-${idx}">
                <option value="list" ${defaultExtract === 'list' ? 'selected' : ''}>list</option>
                <option value="text" ${defaultExtract === 'text' ? 'selected' : ''}>text</option>
                <option value="full_text" ${defaultExtract === 'full_text' ? 'selected' : ''}>full_text</option>
                <option value="rendered_text" ${defaultExtract === 'rendered_text' ? 'selected' : ''}>rendered_text</option>
                <option value="attribute" ${defaultExtract === 'attribute' ? 'selected' : ''}>attribute</option>
                <option value="sibling_text" ${defaultExtract === 'sibling_text' ? 'selected' : ''}>sibling_text</option>
                <option value="hourly_or_fixed_label" ${defaultExtract === 'hourly_or_fixed_label' ? 'selected' : ''}>hourly_or_fixed_label</option>
                <option value="ca_item_value" ${defaultExtract === 'ca_item_value' ? 'selected' : ''}>ca_item_value</option>
              </select>
            </div>
            <div class="sp-card-actions">
              <button type="button" class="btn-secondary js-test-patch" data-idx="${idx}" data-view="${escapeHtml(bf.view)}" data-field="${escapeHtml(bf.field)}">Test</button>
              <button type="button" class="btn-primary js-apply-patch" data-idx="${idx}" data-view="${escapeHtml(bf.view)}" data-field="${escapeHtml(bf.field)}">Apply Patch</button>
            </div>
            <p class="sp-meta sp-patch-feedback" id="sp-patch-feedback-${idx}">${escapeHtml(feedback)}</p>
            ${
              bf.anchor_html
                ? `<details><summary>Anchor HTML</summary><pre class="sp-code-preview">${escapeHtml(bf.anchor_html)}</pre></details>`
                : ''
            }
          </article>
        `;
      })
      .join('');

    return `
      <div class="sp-section" data-testid="failing-fields-inspector">
        <h4>Failing Fields Inspector (${escapeHtml(captureUid || 'active')})</h4>
        <div class="sp-list">${cardsHtml}</div>
      </div>
    `;
  }

  private async renderSelectorsTab(): Promise<void> {
    type CaptureSummaryEntry = NonNullable<SidePanelController['latestCaptureDetail']>['entry'];
    const [data, capturesData] = await Promise.all([
      this.fetchJsonSafe<{ audits?: SelectorAuditRow[] }>(
        '/api/selector-audits?latest=true&limit=20',
        {
          method: 'GET',
        },
      ),
      this.fetchJsonSafe<{ captures?: NonNullable<CaptureSummaryEntry>[] }>(
        '/api/diagnostics/captures?limit=10',
        { method: 'GET' },
      ),
    ]);
    const audits = data?.audits ?? [];
    const captures = capturesData?.captures ?? [];

    if (!this.latestCaptureDetail && captures.length > 0 && captures[0]?.capture_uid) {
      const detail = await this.fetchJsonSafe<
        NonNullable<SidePanelController['latestCaptureDetail']>
      >(`/api/diagnostics/captures/${encodeURIComponent(captures[0].capture_uid)}`, {
        method: 'GET',
      });
      if (detail) {
        this.latestCaptureDetail = detail;
      }
    }

    const capturesHtml =
      captures.length === 0
        ? '<p class="sp-meta">No diagnostic captures persisted yet.</p>'
        : captures
            .map(
              (c) => `
                <div class="sp-capture-row">
                  <span><code>${escapeHtml(c.capture_uid ?? String(c.id ?? ''))}</code> · ${escapeHtml(c.view_type ?? '')} [${escapeHtml(c.overall_status ?? '')}, ${escapeHtml(String(c.broken_count ?? 0))} broken]</span>
                  ${
                    c.capture_uid
                      ? `<button type="button" class="btn-small js-load-capture" data-capture-uid="${escapeHtml(c.capture_uid)}">Inspect</button>`
                      : ''
                  }
                </div>
              `,
            )
            .join('');

    const rowsHtml =
      audits.length === 0
        ? '<p class="empty-state">No selector drift audits recorded yet.</p>'
        : audits
            .map(
              (a) => `
                <article class="sp-card">
                  <div class="sp-card-header">
                    <h4>${escapeHtml(a.view_type)}</h4>
                    <span class="score-pill">${escapeHtml(a.overall_status)}</span>
                  </div>
                  <div class="sp-meta"><span>Audited: ${escapeHtml(a.created_at)}</span></div>
                  ${a.report ? this.renderAuditReportDetails(a.report) : ''}
                </article>
              `,
            )
            .join('');

    if (this.activeTab !== 'selectors') return;

    this.els.contentEl.innerHTML = `
      <section class="sp-panel" data-testid="panel-selectors">
        ${this.renderBrokenFieldsInspector()}
        <div class="sp-list">${rowsHtml}</div>
        <div class="sp-section" data-testid="recent-captures-list">
          <h4>Recent Captures</h4>
          ${capturesHtml}
        </div>
        <div class="sp-toolbar">
          <h3>Selector Health &amp; Diagnostics</h3>
          <select id="sp-audit-view" data-testid="audit-view-select">
            <option value="auto">Auto (Current View)</option>
            <option value="search_listings">search_listings</option>
            <option value="best_matches">best_matches</option>
            <option value="most_recent">most_recent</option>
            <option value="saved_jobs">saved_jobs</option>
            <option value="job_detail">job_detail</option>
            <option value="proposal_apply">proposal_apply</option>
            <option value="proposals_list">proposals_list</option>
            <option value="messages_rooms">messages_rooms</option>
            <option value="messages_thread">messages_thread</option>
          </select>
          <div class="sp-workbench-actions">
            <button type="button" id="sp-capture-active-tab" data-testid="capture-active-tab-btn" class="btn-primary">Capture Active Tab</button>
            <button type="button" id="sp-audit-current-tab" data-testid="audit-current-tab-btn" class="btn-primary">Audit Current Tab</button>
            <button type="button" id="sp-refresh-selectors" data-testid="refresh-selectors-btn" class="btn-secondary">Refresh Selectors</button>
            <button type="button" id="sp-copy-diagnostic-md" data-testid="copy-diagnostic-md-btn" class="btn-secondary">Copy Diagnostic MD</button>
            <button type="button" id="sp-rollback-patch" data-testid="rollback-patch-btn" class="btn-danger">Rollback Last Patch</button>
          </div>
          <label class="sp-checkbox-label">
            <input type="checkbox" id="sp-include-screenshot" ${this.includeScreenshot ? 'checked' : ''} />
            Include Screenshot
          </label>
        </div>
        <p id="sp-selectors-status" class="sp-meta"></p>
      </section>
    `;

    const statusEl = this.els.contentEl.querySelector<HTMLElement>('#sp-selectors-status');
    const setStatus = (msg: string): void => {
      if (statusEl) statusEl.textContent = msg;
    };
    const auditBtn = this.els.contentEl.querySelector<HTMLButtonElement>('#sp-audit-current-tab');
    const captureBtn =
      this.els.contentEl.querySelector<HTMLButtonElement>('#sp-capture-active-tab');
    const viewSelect = this.els.contentEl.querySelector<HTMLSelectElement>('#sp-audit-view');
    const screenshotCheckbox =
      this.els.contentEl.querySelector<HTMLInputElement>('#sp-include-screenshot');

    screenshotCheckbox?.addEventListener('change', () => {
      this.includeScreenshot = Boolean(screenshotCheckbox.checked);
    });

    captureBtn?.addEventListener('click', async () => {
      const selectedView = viewSelect?.value ?? 'auto';
      captureBtn.disabled = true;
      setStatus('Capturing live UI diagnostic bundle...');
      try {
        const res = (await browser.runtime.sendMessage({
          type: 'BG_CAPTURE_UI_DIAGNOSTIC',
          useActiveTab: true,
          view: selectedView === 'auto' ? undefined : selectedView,
          includeScreenshot: this.includeScreenshot,
          redactPii: true,
        })) as
          | (NonNullable<SidePanelController['latestCaptureDetail']> & {
              ok?: boolean;
              error?: string;
            })
          | undefined;
        if (!res?.ok) {
          setStatus(res?.error ?? 'Diagnostic capture failed');
          return;
        }
        this.latestCaptureDetail = res;
        this.patchTestFeedback.clear();
        await this.renderSelectorsTab();
        const uid =
          res.capture_uid ?? res.entry?.capture_uid ?? res.capture?.capture_uid ?? 'captured';
        const refreshedStatus =
          this.els.contentEl.querySelector<HTMLElement>('#sp-selectors-status');
        if (refreshedStatus) {
          refreshedStatus.textContent = `Captured diagnostic ${uid} (${res.capture?.broken_fields?.length ?? 0} broken field(s))`;
        }
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Diagnostic capture failed');
      } finally {
        captureBtn.disabled = false;
      }
    });

    auditBtn?.addEventListener('click', async () => {
      const selectedView = viewSelect?.value ?? 'auto';
      auditBtn.disabled = true;
      setStatus('Running selector audit...');
      try {
        const res = (await browser.runtime.sendMessage({
          type: 'BG_RUN_SELECTOR_AUDIT',
          view: selectedView === 'auto' ? undefined : selectedView,
        })) as { ok?: boolean; overall_status?: string; error?: string } | undefined;
        if (!res?.ok) {
          setStatus(res?.error ?? 'Selector audit failed');
          return;
        }
        await this.renderSelectorsTab();
        const refreshedStatus =
          this.els.contentEl.querySelector<HTMLElement>('#sp-selectors-status');
        if (refreshedStatus) {
          refreshedStatus.textContent = `Audit complete: ${res.overall_status ?? 'HEALTHY'}`;
        }
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'Selector audit failed');
      } finally {
        auditBtn.disabled = false;
      }
    });

    this.els.contentEl
      .querySelector('#sp-refresh-selectors')
      ?.addEventListener('click', async () => {
        try {
          const res = (await browser.runtime.sendMessage({
            type: 'BG_SELECTORS_GET',
            forceRefresh: true,
          })) as { ok?: boolean; selectors?: { version?: string } } | undefined;
          setStatus(
            res?.ok
              ? `Selectors refreshed (v${res.selectors?.version ?? '2.0'})`
              : 'Refresh failed',
          );
        } catch {
          setStatus('Refresh failed');
        }
      });

    this.els.contentEl
      .querySelector('#sp-copy-diagnostic-md')
      ?.addEventListener('click', async () => {
        const md = this.latestCaptureDetail?.markdown;
        if (!md) {
          setStatus('No captured diagnostic markdown to copy yet');
          return;
        }
        if (!navigator.clipboard?.writeText) {
          setStatus('Clipboard write unavailable in this context');
          return;
        }
        try {
          await navigator.clipboard.writeText(md);
          setStatus('Copied diagnostic markdown to clipboard');
        } catch {
          setStatus('Clipboard write unavailable in this context');
        }
      });

    this.els.contentEl
      .querySelector<HTMLButtonElement>('#sp-rollback-patch')
      ?.addEventListener('click', async () => {
        try {
          const res = (await browser.runtime.sendMessage({
            type: 'BG_ROLLBACK_SELECTOR_PATCH',
          })) as
            | { ok?: boolean; version?: string; backup_file?: string; error?: string }
            | undefined;
          if (!res?.ok) {
            setStatus(res?.error ?? 'Rollback failed');
            return;
          }
          await this.renderSelectorsTab();
          const refreshedStatus =
            this.els.contentEl.querySelector<HTMLElement>('#sp-selectors-status');
          if (refreshedStatus) {
            refreshedStatus.textContent = `Rolled back selectors to v${res.version ?? '?'} from ${res.backup_file ?? 'backup'}`;
          }
        } catch (err) {
          setStatus(err instanceof Error ? err.message : 'Rollback failed');
        }
      });

    for (const chip of Array.from(
      this.els.contentEl.querySelectorAll<HTMLButtonElement>('.sp-candidate-chip'),
    )) {
      chip.addEventListener('click', () => {
        const idx = chip.dataset.idx ?? '';
        const selector = chip.dataset.selector ?? '';
        const input = this.els.contentEl.querySelector<HTMLInputElement>(`#sp-patch-input-${idx}`);
        if (input && selector) {
          input.value = selector;
        }
      });
    }

    for (const btn of Array.from(
      this.els.contentEl.querySelectorAll<HTMLButtonElement>('.js-test-patch'),
    )) {
      btn.addEventListener('click', async () => {
        const idx = btn.dataset.idx ?? '';
        const view = btn.dataset.view ?? '';
        const field = btn.dataset.field ?? '';
        const input = this.els.contentEl.querySelector<HTMLInputElement>(`#sp-patch-input-${idx}`);
        const extractSelect = this.els.contentEl.querySelector<HTMLSelectElement>(
          `#sp-patch-extract-${idx}`,
        );
        const feedbackEl = this.els.contentEl.querySelector<HTMLElement>(
          `#sp-patch-feedback-${idx}`,
        );
        const selector = input?.value.trim() ?? '';
        const extract = (extractSelect?.value ?? 'text') as ExtractMode;
        if (!selector) {
          if (feedbackEl) feedbackEl.textContent = 'Enter a CSS selector to test';
          return;
        }
        btn.disabled = true;
        if (feedbackEl) feedbackEl.textContent = 'Testing selector against DOM...';
        try {
          const res = (await browser.runtime.sendMessage({
            type: 'BG_TEST_SELECTOR_PATCH',
            view,
            field,
            rule: { selectors: [selector], extract },
            captureId:
              this.latestCaptureDetail?.capture_uid ?? this.latestCaptureDetail?.entry?.capture_uid,
            useActiveTab: true,
          })) as (SelectorPatchTestResult & { error?: string }) | undefined;
          if (!res) {
            if (feedbackEl) feedbackEl.textContent = 'Dry-run returned empty response';
            return;
          }
          if (res.error) {
            if (feedbackEl) feedbackEl.textContent = res.error;
            return;
          }
          const sampleText = Array.isArray(res.sample_value)
            ? res.sample_value.slice(0, 5).join(', ')
            : String(res.sample_value ?? '(empty)');
          const msg = `${res.after_summary.status}: ${res.matched_count} match(es), regressions=${res.regressions.length}, sample=${sampleText}`;
          this.patchTestFeedback.set(`${view}:${field}`, msg);
          if (feedbackEl) feedbackEl.textContent = msg;
        } catch (err) {
          if (feedbackEl) {
            feedbackEl.textContent = err instanceof Error ? err.message : 'Dry-run test failed';
          }
        } finally {
          btn.disabled = false;
        }
      });
    }

    for (const btn of Array.from(
      this.els.contentEl.querySelectorAll<HTMLButtonElement>('.js-apply-patch'),
    )) {
      btn.addEventListener('click', async () => {
        const idx = btn.dataset.idx ?? '';
        const view = btn.dataset.view ?? '';
        const field = btn.dataset.field ?? '';
        const input = this.els.contentEl.querySelector<HTMLInputElement>(`#sp-patch-input-${idx}`);
        const extractSelect = this.els.contentEl.querySelector<HTMLSelectElement>(
          `#sp-patch-extract-${idx}`,
        );
        const feedbackEl = this.els.contentEl.querySelector<HTMLElement>(
          `#sp-patch-feedback-${idx}`,
        );
        const selector = input?.value.trim() ?? '';
        const extract = (extractSelect?.value ?? 'text') as ExtractMode;
        if (!selector) {
          if (feedbackEl) feedbackEl.textContent = 'Enter a CSS selector to apply';
          return;
        }
        btn.disabled = true;
        setStatus(`Applying patch for ${view}.${field}...`);
        try {
          const res = (await browser.runtime.sendMessage({
            type: 'BG_APPLY_SELECTOR_PATCH',
            view,
            field,
            rule: { selectors: [selector], extract },
            mode: 'prepend',
            reason: 'Patched via Side Panel diagnostic workbench',
            captureId:
              this.latestCaptureDetail?.capture_uid ?? this.latestCaptureDetail?.entry?.capture_uid,
          })) as
            | { ok?: boolean; new_version?: string; backup_file?: string; error?: string }
            | undefined;
          if (!res?.ok) {
            setStatus(res?.error ?? 'Apply patch failed');
            return;
          }
          this.patchTestFeedback.set(
            `${view}:${field}`,
            `Applied in v${res.new_version ?? '?'} (backup: ${res.backup_file ?? 'saved'})`,
          );
          await this.renderSelectorsTab();
          const refreshedStatus =
            this.els.contentEl.querySelector<HTMLElement>('#sp-selectors-status');
          if (refreshedStatus) {
            refreshedStatus.textContent = `Patched ${view}.${field} -> v${res.new_version ?? '?'}`;
          }
        } catch (err) {
          setStatus(err instanceof Error ? err.message : 'Apply patch failed');
        } finally {
          btn.disabled = false;
        }
      });
    }

    for (const btn of Array.from(
      this.els.contentEl.querySelectorAll<HTMLButtonElement>('.js-load-capture'),
    )) {
      btn.addEventListener('click', async () => {
        const uid = btn.dataset.captureUid;
        if (!uid) return;
        const detail = await this.fetchJsonSafe<
          NonNullable<SidePanelController['latestCaptureDetail']>
        >(`/api/diagnostics/captures/${encodeURIComponent(uid)}`, { method: 'GET' });
        if (detail) {
          this.latestCaptureDetail = detail;
          this.patchTestFeedback.clear();
          await this.renderSelectorsTab();
        }
      });
    }
  }

  private formatSidePanelAiBadge(job: SavedJob): { status: string; label: string } {
    const raw = (job.ai_enrichment_status ?? 'none').toLowerCase();
    if (raw === 'queued') {
      return { status: 'queued', label: 'AI Queued' };
    }
    if (raw === 'scraping_details') {
      return { status: 'scraping_details', label: 'AI Scraping...' };
    }
    if (raw === 'analyzing') {
      return { status: 'analyzing', label: 'AI Analyzing...' };
    }
    if (raw === 'failed') {
      return { status: 'failed', label: 'AI Failed' };
    }
    if (raw === 'completed' || job.ai_enriched_at || job.proposal?.trim()) {
      return { status: 'completed', label: 'AI Enriched ✓' };
    }
    if (job.last_enriched_at) {
      return { status: 'detail_only', label: 'AI Status: Details Only' };
    }
    return { status: 'none', label: 'AI Status: Unenriched' };
  }
}
