import type { AnalysisResponse, PortfolioReferenceEntry, SavedJob } from '../types';
import { attachCollapsibleListeners, escapeHtml, renderAnalysis, sanitizeHttpUrl } from '../utils';
import { getEffectiveEnrichmentState } from './jobs-table';

export type DrawerTab = 'overview' | 'ai';

export interface JobInspectorDrawerCallbacks {
  onEnrichJob: (job: SavedJob) => Promise<SavedJob | null>;
  onSaveProposalDraft: (job: SavedJob) => Promise<void>;
  onClose?: () => void;
}

export interface JobInspectorDrawerOptions {
  container: HTMLElement;
  callbacks: JobInspectorDrawerCallbacks;
}

function buildJobSignature(job: SavedJob): string {
  return JSON.stringify([
    job.id,
    job.updated_at ?? '',
    job.job_title ?? '',
    job.job_description ?? '',
    job.status ?? '',
    job.score ?? '',
    job.fit_label ?? '',
    job.score_reasoning ?? '',
    job.score_breakdown ?? null,
    job.last_enriched_at ?? '',
    job.ai_enrichment_status ?? '',
    job.ai_enriched_at ?? '',
    job.ai_enrichment_error ?? '',
    job.ai_model ?? '',
    job.ai_effort ?? '',
    job.ai_tokens_used ?? '',
    job.proposal ?? '',
    job.execution_prompt ?? '',
    job.time_estimate ?? '',
    job.tone_analysis ?? '',
    job.workload_division ?? null,
    job.questions_for_client ?? null,
    job.tips_and_advice ?? null,
    job.portfolio_references ?? [],
    job.skills ?? '',
    job.attachments ?? [],
    job.screening_questions ?? [],
    job.qualifications ?? [],
    job.client_activity ?? null,
  ]);
}

function parseSkillsList(skills: string | string[] | undefined): string[] {
  if (Array.isArray(skills)) {
    return skills.map((s) => String(s).trim()).filter(Boolean);
  }
  if (typeof skills === 'string') {
    return skills
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

type LegacyPortfolioRef = PortfolioReferenceEntry & { title?: string; url?: string };

function normalizeCountField(val: unknown): string | number {
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : 0;
  }
  return typeof val === 'string' ? val : 0;
}

function renderPortfolioReferences(refs: PortfolioReferenceEntry[] | undefined): string {
  if (!refs || refs.length === 0) {
    return '<p class="dash-muted">No portfolio or active-project references attached yet.</p>';
  }
  return `<div class="dash-refs-list">${refs
    .map((rawRef) => {
      const ref = rawRef as LegacyPortfolioRef;
      const isPublic = ref.visibility === 'public';
      const visLabel = isPublic ? '[PUBLIC]' : '[ANONYMIZED/NDA]';
      const visClass = isPublic ? 'dash-vis-public' : 'dash-vis-nda';
      const displayName = ref.display_name?.trim() || ref.title?.trim() || 'Untitled Reference';
      const rawLink = ref.link ?? ref.url;
      const safeLink = rawLink ? sanitizeHttpUrl(rawLink) : null;
      const sourceLabel = ref.source ?? '';
      const techTags = Array.isArray(ref.tech_stack)
        ? ref.tech_stack
            .map((t) => `<span class="dash-skill-chip">${escapeHtml(t)}</span>`)
            .join('')
        : '';
      return `<div class="dash-ref-card">
        <div class="dash-ref-header">
          <span class="dash-vis-badge ${visClass}">${visLabel}</span>
          <strong>${escapeHtml(displayName)}</strong>
          ${sourceLabel ? `<span class="dash-muted">${escapeHtml(sourceLabel)}</span>` : ''}
          ${ref.activity_tier ? `<span class="dash-muted">· ${escapeHtml(ref.activity_tier)}</span>` : ''}
        </div>
        ${ref.summary ? `<p class="dash-ref-summary">${escapeHtml(ref.summary)}</p>` : ''}
        ${techTags ? `<div class="dash-skills-wrap">${techTags}</div>` : ''}
        ${safeLink ? `<a class="dash-ext-link" href="${escapeHtml(safeLink)}" target="_blank" rel="noopener noreferrer">View reference ↗</a>` : ''}
      </div>`;
    })
    .join('')}</div>`;
}

export class JobInspectorDrawer {
  private readonly container: HTMLElement;
  private readonly callbacks: JobInspectorDrawerCallbacks;

  private currentJob: SavedJob | null = null;
  private currentSignature = '';
  private activeTab: DrawerTab = 'overview';
  private isOpen = false;
  private destroyed = false;
  private openGeneration = 0;
  private isEnriching = false;
  private isSavingDraft = false;
  private actionMessage = '';
  private actionTone: 'neutral' | 'success' | 'error' = 'neutral';

  private readonly onKeyDown: (e: KeyboardEvent) => void;
  private readonly onClick: (event: MouseEvent) => void;

  constructor(options: JobInspectorDrawerOptions) {
    this.container = options.container;
    this.callbacks = options.callbacks;
    this.onKeyDown = (e: KeyboardEvent) => {
      if (!this.destroyed && e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    };
    this.onClick = (event: MouseEvent) => {
      if (this.destroyed) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;

      if (
        target.closest('[data-testid="drawer-close-btn"]') ||
        target.classList.contains('dash-drawer-backdrop')
      ) {
        this.close();
        return;
      }

      if (target.closest('[data-testid="drawer-tab-overview"]')) {
        this.activeTab = 'overview';
        this.render();
        return;
      }

      if (target.closest('[data-testid="drawer-tab-ai"]')) {
        this.activeTab = 'ai';
        this.render();
        return;
      }

      if (target.closest('[data-testid="drawer-enrich-btn"]')) {
        void this.handleEnrichClick();
        return;
      }

      if (target.closest('[data-testid="save-proposal-draft-btn"]')) {
        void this.handleSaveDraftClick();
        return;
      }

      if (target.closest('[data-testid="copy-execution-prompt-btn"]')) {
        void this.handleCopyPromptClick();
      }
    };
    document.addEventListener('keydown', this.onKeyDown);
    this.bindEvents();
    this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.isOpen = false;
    this.openGeneration += 1;
    document.removeEventListener('keydown', this.onKeyDown);
    this.container.removeEventListener('click', this.onClick);
  }

  getIsOpen(): boolean {
    return this.isOpen;
  }

  getActiveTab(): DrawerTab {
    return this.activeTab;
  }

  getCurrentJobId(): number | null {
    return this.currentJob?.id ?? null;
  }

  /**
   * Opens the drawer for a job and ALWAYS resets activeTab to 'overview'.
   */
  open(job: SavedJob): void {
    if (this.destroyed) return;
    this.openGeneration += 1;
    this.currentJob = job;
    this.currentSignature = buildJobSignature(job);
    this.activeTab = 'overview';
    this.isOpen = true;
    this.isEnriching = false;
    this.isSavingDraft = false;
    this.actionMessage = '';
    this.actionTone = 'neutral';
    this.render();
  }

  /**
   * Updates the drawer in-place when polling refreshes the currently open job,
   * preserving activeTab and scroll position.
   */
  updateJobIfOpen(job: SavedJob): void {
    if (this.destroyed || !this.isOpen || !this.currentJob || this.currentJob.id !== job.id) {
      return;
    }
    const nextSig = buildJobSignature(job);
    if (nextSig === this.currentSignature) {
      return;
    }
    this.currentJob = job;
    this.currentSignature = nextSig;
    const bodyEl = this.container.querySelector<HTMLElement>('.dash-drawer-body');
    const prevScroll = bodyEl?.scrollTop ?? 0;
    this.render();
    const nextBodyEl = this.container.querySelector<HTMLElement>('.dash-drawer-body');
    if (nextBodyEl) {
      nextBodyEl.scrollTop = prevScroll;
    }
  }

  close(): void {
    if (this.destroyed || !this.isOpen) return;
    this.openGeneration += 1;
    this.isOpen = false;
    this.currentJob = null;
    this.currentSignature = '';
    this.isEnriching = false;
    this.isSavingDraft = false;
    this.actionMessage = '';
    this.actionTone = 'neutral';
    this.render();
    this.callbacks.onClose?.();
  }

  private bindEvents(): void {
    if (this.destroyed) return;
    this.container.addEventListener('click', this.onClick);
  }

  private async handleEnrichClick(): Promise<void> {
    if (this.destroyed || !this.currentJob || this.isEnriching) return;
    const job = this.currentJob;
    const gen = this.openGeneration;
    const jobId = job.id;
    this.isEnriching = true;
    this.actionMessage = 'Running AI analysis...';
    this.actionTone = 'neutral';
    this.render();
    try {
      const updated = await this.callbacks.onEnrichJob(job);
      if (
        this.destroyed ||
        !this.isOpen ||
        this.openGeneration !== gen ||
        this.currentJob?.id !== jobId
      ) {
        return;
      }
      if (updated) {
        this.currentJob = updated;
        this.currentSignature = buildJobSignature(updated);
      }
      if (updated?.ai_enrichment_status === 'failed' || updated?.ai_enrichment_error) {
        this.actionMessage = updated?.ai_enrichment_error || 'Enrichment failed';
        this.actionTone = 'error';
      } else {
        this.actionMessage = 'AI analysis complete.';
        this.actionTone = 'success';
      }
    } catch (err) {
      if (
        this.destroyed ||
        !this.isOpen ||
        this.openGeneration !== gen ||
        this.currentJob?.id !== jobId
      ) {
        return;
      }
      this.actionMessage = err instanceof Error ? err.message : 'Enrichment failed';
      this.actionTone = 'error';
    } finally {
      if (
        !this.destroyed &&
        this.isOpen &&
        this.openGeneration === gen &&
        this.currentJob?.id === jobId
      ) {
        this.isEnriching = false;
        this.render();
      }
    }
  }

  private async handleSaveDraftClick(): Promise<void> {
    if (this.destroyed || !this.currentJob || this.isSavingDraft) return;
    const job = this.currentJob;
    const gen = this.openGeneration;
    const jobId = job.id;
    this.isSavingDraft = true;
    this.actionMessage = 'Saving proposal draft...';
    this.actionTone = 'neutral';
    this.render();
    try {
      await this.callbacks.onSaveProposalDraft(job);
      if (
        this.destroyed ||
        !this.isOpen ||
        this.openGeneration !== gen ||
        this.currentJob?.id !== jobId
      ) {
        return;
      }
      this.actionMessage = 'Saved as proposal draft.';
      this.actionTone = 'success';
    } catch (err) {
      if (
        this.destroyed ||
        !this.isOpen ||
        this.openGeneration !== gen ||
        this.currentJob?.id !== jobId
      ) {
        return;
      }
      this.actionMessage = err instanceof Error ? err.message : 'Failed to save draft';
      this.actionTone = 'error';
    } finally {
      if (
        !this.destroyed &&
        this.isOpen &&
        this.openGeneration === gen &&
        this.currentJob?.id === jobId
      ) {
        this.isSavingDraft = false;
        this.render();
      }
    }
  }

  private async handleCopyPromptClick(): Promise<void> {
    if (this.destroyed) return;
    const job = this.currentJob;
    const prompt = job?.execution_prompt ?? '';
    if (!job || !prompt) return;
    const gen = this.openGeneration;
    const jobId = job.id;
    try {
      await navigator.clipboard?.writeText(prompt);
      if (
        this.destroyed ||
        !this.isOpen ||
        this.openGeneration !== gen ||
        this.currentJob?.id !== jobId
      ) {
        return;
      }
      this.actionMessage = 'Execution prompt copied to clipboard.';
      this.actionTone = 'success';
    } catch {
      if (
        this.destroyed ||
        !this.isOpen ||
        this.openGeneration !== gen ||
        this.currentJob?.id !== jobId
      ) {
        return;
      }
      this.actionMessage = 'Clipboard unavailable in this context.';
      this.actionTone = 'error';
    }
    if (
      this.destroyed ||
      !this.isOpen ||
      this.openGeneration !== gen ||
      this.currentJob?.id !== jobId
    ) {
      return;
    }
    this.render();
  }

  private renderOverviewTab(job: SavedJob): string {
    const skills = parseSkillsList(job.skills);
    const screening = Array.isArray(job.screening_questions) ? job.screening_questions : [];
    const qualifications = Array.isArray(job.qualifications) ? job.qualifications : [];
    const attachments = Array.isArray(job.attachments) ? job.attachments : [];
    const breakdown = job.score_breakdown ?? {};
    const matchedActive = Array.isArray(breakdown.matched_active_projects)
      ? breakdown.matched_active_projects
      : [];

    return `
      <section class="dash-drawer-section">
        <h3>Client &amp; Job Signals</h3>
        <div class="dash-kv-grid">
          <div><span class="dash-kv-label">Contract</span><strong>${escapeHtml(job.contract_type || 'N/A')}</strong></div>
          <div><span class="dash-kv-label">Budget / Rate</span><strong>${escapeHtml(job.budget || job.rate_range || job.budget_amount || 'N/A')}</strong></div>
          <div><span class="dash-kv-label">Experience</span><strong>${escapeHtml(job.experience_level || 'N/A')}</strong></div>
          <div><span class="dash-kv-label">Duration</span><strong>${escapeHtml(job.duration || 'N/A')}</strong></div>
          <div><span class="dash-kv-label">Hours / Week</span><strong>${escapeHtml(job.hours_per_week || 'N/A')}</strong></div>
          <div><span class="dash-kv-label">Payment</span><strong>${job.payment_verified === true ? 'Verified' : job.payment_verified === false ? 'Unverified' : 'Unknown'}</strong></div>
          <div><span class="dash-kv-label">Client Spent</span><strong>${escapeHtml(job.client_spent || 'N/A')}</strong></div>
          <div><span class="dash-kv-label">Client Rating</span><strong>${typeof job.client_rating === 'number' && Number.isFinite(job.client_rating) ? `${escapeHtml(String(job.client_rating))} (${escapeHtml(String(normalizeCountField(job.client_reviews)))} reviews)` : 'N/A'}</strong></div>
          <div><span class="dash-kv-label">Client Hires / Rate</span><strong>${typeof job.client_hires === 'number' && Number.isFinite(job.client_hires) ? escapeHtml(String(job.client_hires)) : '--'} / ${typeof job.client_hire_rate === 'number' && Number.isFinite(job.client_hire_rate) ? `${escapeHtml(String(Math.round(job.client_hire_rate)))}%` : '--'}</strong></div>
          <div><span class="dash-kv-label">Country</span><strong>${escapeHtml(job.client_country || 'N/A')}</strong></div>
          <div><span class="dash-kv-label">Proposals</span><strong>${escapeHtml(job.proposals_tier || (typeof job.proposals_count === 'number' && Number.isFinite(job.proposals_count) ? String(job.proposals_count) : 'N/A'))}</strong></div>
          <div><span class="dash-kv-label">Connects</span><strong>${typeof job.connects_required === 'number' && Number.isFinite(job.connects_required) ? escapeHtml(String(job.connects_required)) : 'N/A'}</strong></div>
        </div>
        ${
          job.client_activity
            ? `<p class="dash-muted dash-activity-line">Activity: interviewing ${escapeHtml(String(normalizeCountField(job.client_activity.interviewing)))} · invites ${escapeHtml(String(normalizeCountField(job.client_activity.invites_sent)))} · unanswered ${escapeHtml(String(normalizeCountField(job.client_activity.unanswered_invites)))}${job.client_activity.last_viewed ? ` · last viewed ${escapeHtml(job.client_activity.last_viewed)}` : ''}</p>`
            : ''
        }
      </section>

      <section class="dash-drawer-section">
        <h3>Job Description</h3>
        <div class="dash-description-box">${escapeHtml(job.job_description || 'No description stored.').replace(/\n/g, '<br>')}</div>
      </section>

      ${
        skills.length > 0
          ? `<section class="dash-drawer-section">
              <h3>Skills</h3>
              <div class="dash-skills-wrap">${skills.map((s) => `<span class="dash-skill-chip">${escapeHtml(s)}</span>`).join('')}</div>
            </section>`
          : ''
      }

      ${
        matchedActive.length > 0 || job.score_reasoning
          ? `<section class="dash-drawer-section">
              <h3>Score &amp; Active Project Overlap</h3>
              ${job.score_reasoning ? `<p>${escapeHtml(job.score_reasoning)}</p>` : ''}
              ${
                matchedActive.length > 0
                  ? `<div class="dash-skills-wrap">${matchedActive.map((p) => `<span class="dash-proj-badge">${escapeHtml(String(p))}</span>`).join('')}</div>`
                  : ''
              }
            </section>`
          : ''
      }

      ${
        screening.length > 0
          ? `<section class="dash-drawer-section">
              <h3>Screening Questions</h3>
              <ol class="dash-list">${screening.map((q) => `<li>${escapeHtml(q.prompt)}${q.required ? ' <span class="dash-req-tag">(Required)</span>' : ''}</li>`).join('')}</ol>
            </section>`
          : ''
      }

      ${
        qualifications.length > 0
          ? `<section class="dash-drawer-section">
              <h3>Qualifications</h3>
              <ul class="dash-list">${qualifications.map((q) => `<li>${q.met === true ? '✓ ' : q.met === false ? '✗ ' : '• '}<strong>${escapeHtml(q.name)}:</strong> ${escapeHtml(q.value)}</li>`).join('')}</ul>
            </section>`
          : ''
      }

      ${
        attachments.length > 0
          ? `<section class="dash-drawer-section">
              <h3>Attachments</h3>
              <ul class="dash-list">${attachments
                .map((att) => {
                  if (!att || typeof att !== 'object') return '';
                  const safeAtt = att.url ? sanitizeHttpUrl(att.url) : null;
                  const label =
                    att.filename || (att as { title?: string }).title || safeAtt || 'Attachment';
                  return safeAtt
                    ? `<li><a href="${escapeHtml(safeAtt)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a></li>`
                    : `<li>${escapeHtml(label)} <span class="dash-muted">(unsafe link blocked)</span></li>`;
                })
                .join('')}</ul>
            </section>`
          : ''
      }
    `;
  }

  private renderAiTab(job: SavedJob): string {
    const enrichState = getEffectiveEnrichmentState(job);
    const hasProposal = Boolean(job.proposal?.trim());
    const analysisObj: AnalysisResponse = {};
    if (job.proposal) analysisObj.proposal = job.proposal;
    if (job.execution_prompt) analysisObj.execution_prompt = job.execution_prompt;
    if (job.time_estimate) analysisObj.time_estimate = job.time_estimate;
    if (job.workload_division) {
      analysisObj.workload_division =
        job.workload_division as AnalysisResponse['workload_division'];
    }
    if (job.questions_for_client) {
      analysisObj.questions_for_client =
        job.questions_for_client as AnalysisResponse['questions_for_client'];
    }
    if (job.tips_and_advice) {
      analysisObj.tips_and_advice = job.tips_and_advice as AnalysisResponse['tips_and_advice'];
    }
    if (job.tone_analysis) analysisObj.tone_analysis = job.tone_analysis;

    const hasAnyAnalysis = Object.keys(analysisObj).length > 0;

    return `
      <div class="dash-drawer-ai-actions">
        <button type="button" class="dash-btn-primary" data-testid="drawer-enrich-btn" ${this.isEnriching ? 'disabled' : ''}>
          ${this.isEnriching ? 'Analyzing...' : 'Enrich / Re-Analyze'}
        </button>
        <button type="button" class="dash-btn-secondary" data-testid="save-proposal-draft-btn" ${!hasProposal || this.isSavingDraft ? 'disabled' : ''}>
          ${this.isSavingDraft ? 'Saving...' : 'Save as Proposal Draft'}
        </button>
      </div>

      ${
        this.actionMessage
          ? `<div class="dash-banner dash-banner-${this.actionTone}" data-testid="drawer-action-feedback">${escapeHtml(this.actionMessage)}</div>`
          : ''
      }

      <div class="dash-ai-meta-strip">
        <span><strong>Status:</strong> ${escapeHtml(enrichState.label)}</span>
        ${job.ai_model ? `<span><strong>Model:</strong> ${escapeHtml(job.ai_model)}</span>` : ''}
        ${job.ai_effort ? `<span><strong>Effort:</strong> ${escapeHtml(job.ai_effort)}</span>` : ''}
        ${typeof job.ai_tokens_used === 'number' && Number.isFinite(job.ai_tokens_used) ? `<span><strong>Tokens:</strong> ${escapeHtml(String(job.ai_tokens_used))}</span>` : ''}
        ${job.ai_enriched_at ? `<span><strong>Enriched:</strong> ${escapeHtml(job.ai_enriched_at)}</span>` : ''}
      </div>

      ${
        job.ai_enrichment_error
          ? `<div class="dash-banner dash-banner-error">${escapeHtml(job.ai_enrichment_error)}</div>`
          : ''
      }

      <section class="dash-drawer-section">
        <h3>Portfolio &amp; Active Project References</h3>
        ${renderPortfolioReferences(job.portfolio_references)}
      </section>

      ${
        job.execution_prompt
          ? `<section class="dash-drawer-section">
              <div class="dash-section-head-row">
                <h3>Execution Prompt</h3>
                <button type="button" class="dash-btn-sm" data-testid="copy-execution-prompt-btn">Copy Execution Prompt</button>
              </div>
              <pre class="dash-code-box">${escapeHtml(job.execution_prompt)}</pre>
            </section>`
          : ''
      }

      <section class="dash-drawer-section">
        <h3>AI Analysis</h3>
        ${
          hasAnyAnalysis
            ? `<div class="dash-analysis-wrap">${renderAnalysis(analysisObj, false)}</div>`
            : '<p class="dash-muted">No AI analysis generated yet. Click "Enrich / Re-Analyze" to analyze this job.</p>'
        }
      </section>
    `;
  }

  render(): void {
    if (this.destroyed) return;
    if (!this.isOpen || !this.currentJob) {
      this.container.innerHTML = '';
      this.container.hidden = true;
      return;
    }

    const job = this.currentJob;
    const safeUrl = sanitizeHttpUrl(job.canonical_url ?? job.url ?? '');
    const scoreText =
      typeof job.score === 'number' && Number.isFinite(job.score)
        ? `${Math.round(job.score)}`
        : '--';

    this.container.hidden = false;
    this.container.innerHTML = `
      <div class="dash-drawer-backdrop"></div>
      <aside class="dash-drawer-panel" role="dialog" aria-modal="true" aria-label="Job Inspector" data-testid="job-inspector-drawer">
        <header class="dash-drawer-header">
          <div class="dash-drawer-title-wrap">
            <h2>${escapeHtml(job.job_title || 'Untitled Job')}</h2>
            <div class="dash-drawer-badges">
              <span class="dash-score-pill">${escapeHtml(scoreText)} ${escapeHtml(job.fit_label ?? '')}</span>
              ${safeUrl ? `<a class="dash-ext-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer">Open on Upwork ↗</a>` : ''}
            </div>
          </div>
          <button type="button" class="dash-btn-sm" data-testid="drawer-close-btn" aria-label="Close drawer">Close</button>
        </header>

        <div class="dash-drawer-tabs" role="tablist">
          <button type="button" role="tab" aria-selected="${this.activeTab === 'overview' ? 'true' : 'false'}" class="dash-drawer-tab ${this.activeTab === 'overview' ? 'active' : ''}" data-testid="drawer-tab-overview">
            Overview &amp; Client Signals
          </button>
          <button type="button" role="tab" aria-selected="${this.activeTab === 'ai' ? 'true' : 'false'}" class="dash-drawer-tab ${this.activeTab === 'ai' ? 'active' : ''}" data-testid="drawer-tab-ai">
            AI Analysis
          </button>
        </div>

        <div class="dash-drawer-body">
          ${this.activeTab === 'overview' ? this.renderOverviewTab(job) : this.renderAiTab(job)}
        </div>
      </aside>
    `;

    if (this.activeTab === 'ai') {
      attachCollapsibleListeners(this.container);
    }
  }
}
