/**
 * Main entry point for Upwork Buddy content coordinator
 * Initializes all modules and wires up the application
 */

import { browser } from 'wxt/browser';
import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import { ApiClient } from './api';
import { extractJobDetail } from './content/adapters/detail-adapter';
import { JobExtractor } from './job-extractor';
import { loadActiveSelectors } from './shared/selectors';
import { StateManager } from './state';
import { StorageAdapter } from './storage';
import { injectStyles } from './styles';
import type { SavedJob } from './types';
import { CONFIG, detectEnvironment, loadConfig } from './types';
import { ButtonManager } from './ui/buttons';
import { JobHistoryPanel } from './ui/job-history';
import { Modal } from './ui/modal';
import { ProfileConfigUI } from './ui/profile-config';
import { ProjectsListUI } from './ui/projects-list';
import { TemplateBrowser } from './ui/template-browser';
import { attachCollapsibleListeners, escapeHtml, renderAnalysis } from './utils';

export interface UpworkBuddyOptions {
  uiRoot?: HTMLElement;
  styleRoot?: ParentNode;
  skipLegacyStyleTag?: boolean;
  alwaysShowToolbar?: boolean;
  ctx?: ContentScriptContext;
}

export class UpworkBuddy {
  private stateManager: StateManager;
  private apiClient: ApiClient;
  private jobExtractor: JobExtractor;
  private modal: Modal;
  private buttonManager: ButtonManager;
  private profileConfigUI: ProfileConfigUI | null = null;
  private projectsListUI: ProjectsListUI | null = null;
  private jobHistoryPanel: JobHistoryPanel | null = null;
  private templateBrowser: TemplateBrowser | null = null;
  private drawerOpen = false;
  private healthChecked = false;
  private drawerObserver: MutationObserver | null = null;
  private logPrefix = '[UpworkBuddy][Main]';

  private readonly uiRoot: HTMLElement;
  private readonly styleRoot: ParentNode;

  constructor(options: UpworkBuddyOptions = {}) {
    this.uiRoot = options.uiRoot ?? document.body;
    this.styleRoot = options.styleRoot ?? document;

    this.stateManager = new StateManager();
    this.apiClient = new ApiClient();
    this.jobExtractor = new JobExtractor();

    if (!options.skipLegacyStyleTag) {
      injectStyles();
    }

    this.buttonManager = new ButtonManager(
      () => this.handleAnalyze(false),
      () => this.openProfileConfig(),
      () => this.showProjectsList(),
      () => this.showJobHistory(),
      () => this.showTemplateBrowser(),
      {
        mountTarget: this.uiRoot,
        alwaysShowContainer: options.alwaysShowToolbar,
        onSaveJob: () => this.handleAnalyze(true),
        onOpenSidePanel: () => {
          void this.openSidePanel();
        },
      },
    );

    this.modal = new Modal(this.uiRoot);

    options.ctx?.onInvalidated(() => {
      this.destroy();
    });

    void this.initialize();
  }

  destroy(): void {
    this.drawerObserver?.disconnect();
    this.drawerObserver = null;
    this.modal.destroy();
    this.buttonManager.getContainer().remove();
  }

  setToolbarStatus(connected: boolean, policyMode = 'confirm_in_ui', challenge = false): void {
    this.buttonManager.setStatus(connected, policyMode, challenge);
  }

  async triggerCapture(saveOnly = false): Promise<void> {
    await this.handleAnalyze(saveOnly);
  }

  private async openSidePanel(): Promise<void> {
    try {
      await browser.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
    } catch (error) {
      this.log('Failed to open side panel', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async initialize(): Promise<void> {
    const storage = new StorageAdapter();
    const envOverride = await storage.getEnvOverride();
    const customOverrides = await storage.getCustomConfig();

    const detectedEnv = detectEnvironment();
    const resolvedEnv = envOverride ?? undefined;
    const resolvedConfig = loadConfig(resolvedEnv, customOverrides ?? undefined);
    Object.assign(CONFIG, resolvedConfig);

    console.log(
      `🌍 Upwork Buddy starting in "${resolvedConfig.env}" environment (detected: "${detectedEnv}"${envOverride ? `, override: "${envOverride}"` : ''})`,
    );
    if (customOverrides) {
      console.log('🔧 Custom config overrides applied:', customOverrides);
    }

    this.log('Initializing extension...');
    await this.stateManager.initializeStorage();
    this.log('Storage initialized', { cacheSize: this.stateManager.getCacheSize() });
    await this.stateManager.loadProfile();

    if (this.stateManager.getCacheSize() > 0) {
      this.log('Cached projects detected, bootstrapping ProjectsListUI');
      const modalBody = this.modal.getBody();
      this.projectsListUI = new ProjectsListUI(this.stateManager, modalBody, this.styleRoot);
      this.projectsListUI.updateBadge();
      this.log('ProjectsListUI ready with initial badge update');
    }

    const initialDrawer = this.jobExtractor.findJobDrawer();
    if (initialDrawer) {
      this.drawerOpen = true;
      this.buttonManager.showContainer();
      initialDrawer.setAttribute('data-upwork-buddy', 'true');
      this.runHealthCheck(initialDrawer);
      this.healthChecked = true;
    } else if (this.isStandaloneJobDetailView()) {
      this.buttonManager.showContainer();
      const detailContainer = document.querySelector('.job-details-card') ?? document.body;
      this.runHealthCheck(detailContainer);
      this.healthChecked = true;
    }

    this.watchForDrawer();

    console.log('✅ Upwork Buddy activated! Open a job to see the Analyze button.');
  }

  private isStandaloneJobDetailView(): boolean {
    try {
      return /^\/jobs\/~[a-zA-Z0-9]+/.test(window.location.pathname);
    } catch {
      return false;
    }
  }

  private resolveJobContainer(): Element | null {
    const drawer = this.jobExtractor.findJobDrawer();
    if (drawer) {
      return drawer;
    }
    if (this.isStandaloneJobDetailView()) {
      return (
        document.querySelector('.job-details-card') ??
        document.querySelector('main') ??
        document.body
      );
    }
    return null;
  }

  private resolveCurrentJobUrl(container: Element): string | undefined {
    try {
      if (this.isStandaloneJobDetailView() && window.location?.href) {
        return window.location.href;
      }
      const dataJobId = container.getAttribute('data-job-id')?.trim();
      if (dataJobId && /^~[0-9a-zA-Z]+$/.test(dataJobId)) {
        return `https://www.upwork.com/jobs/${dataJobId}/`;
      }
      const link =
        container.querySelector<HTMLAnchorElement>('a[href*="/jobs/"][href*="~"]') ??
        document.querySelector<HTMLAnchorElement>('a[href*="/jobs/"][href*="~"]');
      if (link?.href) {
        return link.href;
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  private runHealthCheck(targetContainer?: Element): void {
    const results = this.jobExtractor.healthCheck(targetContainer);
    const brokenFields = results.filter((r) => r.status === 'broken');

    if (brokenFields.length > 0) {
      this.log('Health check: broken fields detected', {
        broken: brokenFields.map((f) => f.field),
      });
      this.showHealthWarning(brokenFields.map((f) => f.field));
    } else {
      const fallbackFields = results.filter((r) => r.status === 'fallback');
      if (fallbackFields.length > 0) {
        this.log('Health check: some fields using fallback selectors', {
          fallback: fallbackFields.map((f) => f.field),
        });
      } else {
        this.log('Health check: all selectors ok');
      }
    }
  }

  private showHealthWarning(brokenFields: string[]): void {
    if (this.styleRoot.querySelector('#upwork-buddy-health-warning')) {
      return;
    }

    const banner = document.createElement('div');
    banner.id = 'upwork-buddy-health-warning';
    banner.className = 'upwork-buddy-health-warning';
    banner.innerHTML = `
      <span>⚠️ Upwork Buddy: Some selectors need updating (${escapeHtml(brokenFields.join(', '))}). Job extraction may be incomplete.</span>
      <button type="button" class="upwork-buddy-health-dismiss" title="Dismiss for this session">✕</button>
    `;

    banner.querySelector('.upwork-buddy-health-dismiss')?.addEventListener('click', () => {
      banner.remove();
    });

    this.uiRoot.appendChild(banner);
  }

  private watchForDrawer(): void {
    console.log('👀 Watching for job details drawer...');

    const observer = new MutationObserver(() => {
      const drawer = this.jobExtractor.findJobDrawer();

      if (drawer && !drawer.hasAttribute('data-upwork-buddy')) {
        console.log('✅ Job details drawer found!');
        this.drawerOpen = true;
        this.buttonManager.showContainer();
        drawer.setAttribute('data-upwork-buddy', 'true');
        if (!this.healthChecked) {
          this.runHealthCheck(drawer);
          this.healthChecked = true;
        }
      } else if (!drawer && this.drawerOpen) {
        this.drawerOpen = false;
        console.log('👋 Job details drawer closed');
        this.buttonManager.hideContainer();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    this.drawerObserver = observer;

    console.log('✅ Drawer observer activated');
  }

  private async handleAnalyze(saveOnly = false): Promise<void> {
    this.modal.open();
    const modalBody = this.modal.getBody();

    const container = this.resolveJobContainer();
    if (!container) {
      modalBody.innerHTML = `
        <div class="upwork-buddy-error">
          ❌ Could not find the open job details drawer or job page. Open a job posting and try again.
        </div>
      `;
      return;
    }

    modalBody.innerHTML = saveOnly
      ? '<div class="upwork-buddy-loading">💾 Saving job to Upwork Buddy...</div>'
      : '<div class="upwork-buddy-loading">🤖 Saving and analyzing job posting...</div>';

    try {
      const jobInfo = this.jobExtractor.extractJobInfo(container);
      const jobUrl = this.resolveCurrentJobUrl(container);
      const selectors = await loadActiveSelectors().catch(() => undefined);
      const detailRes = extractJobDetail(container, { url: jobUrl, selectors });
      const enrichedPayload = detailRes.ok ? detailRes.payload : undefined;
      console.log('📊 Extracting job info:', jobInfo, {
        jobUrl,
        enriched: Boolean(enrichedPayload),
      });

      const baseSavePayload = {
        ...(enrichedPayload ?? {}),
        job_title: enrichedPayload?.job_title || jobInfo.title,
        job_description: enrichedPayload?.job_description || jobInfo.description,
        url: jobUrl ?? enrichedPayload?.url,
        job_url: jobUrl ?? enrichedPayload?.job_url,
        source: 'chrome_extension_toolbar',
        contract_type: jobInfo.contractType || enrichedPayload?.contract_type || '',
        budget:
          jobInfo.budget !== 'Not specified'
            ? jobInfo.budget
            : (enrichedPayload?.budget ?? jobInfo.budget),
        rate_range: jobInfo.rateRange || enrichedPayload?.rate_range || '',
        rate_min: jobInfo.rateMin || enrichedPayload?.rate_min || '',
        rate_max: jobInfo.rateMax || enrichedPayload?.rate_max || '',
        budget_amount: jobInfo.budgetAmount || enrichedPayload?.budget_amount || '',
        experience_level:
          jobInfo.experienceLevel !== 'Not specified'
            ? jobInfo.experienceLevel
            : (enrichedPayload?.experience_level ?? jobInfo.experienceLevel),
        skills:
          jobInfo.skills !== 'Not specified'
            ? jobInfo.skills
            : typeof enrichedPayload?.skills === 'string'
              ? enrichedPayload.skills
              : jobInfo.skills,
      };

      // Upsert POST /api/jobs first so job capture succeeds even when Ollama is offline
      let savedJob: SavedJob | null = null;
      try {
        savedJob = await this.stateManager.saveJobToHistory({
          ...baseSavePayload,
          proposal: '',
          time_estimate: '',
          execution_prompt: '',
          tone_analysis: '',
        });
        this.log('Job upserted to backend', { id: savedJob.id, url: jobUrl });
      } catch (saveError) {
        console.warn('⚠️ Initial job upsert failed:', saveError);
        if (saveOnly) {
          throw saveError;
        }
      }

      if (saveOnly) {
        modalBody.innerHTML = `
          <div class="upwork-buddy-section">
            <div class="upwork-buddy-section-body">
              <h3 style="margin-top:0;color:#14a800;">✅ Job Saved to Pipeline</h3>
              <p><strong>${escapeHtml(baseSavePayload.job_title)}</strong></p>
              ${jobUrl ? `<p>${escapeHtml(jobUrl)}</p>` : ''}
            </div>
          </div>
        `;
        return;
      }

      const profile = this.stateManager.getProfile();
      const profileDescription = profile.description?.trim() || CONFIG.defaultProfile;
      const profileSkills = profile.skills?.trim() || CONFIG.defaultSkills;

      const analysis = await this.apiClient.analyzeJob(jobInfo, profileDescription, profileSkills);
      console.log('✅ Got analysis response:', analysis);

      await this.stateManager.cacheAnalysis(jobInfo, analysis);
      this.log('Analysis cached', { cacheSize: this.stateManager.getCacheSize() });

      try {
        await this.stateManager.saveJobToHistory({
          ...baseSavePayload,
          proposal: analysis.proposal || '',
          time_estimate: analysis.time_estimate || '',
          execution_prompt: analysis.execution_prompt || '',
          tone_analysis: analysis.tone_analysis || '',
        });
        this.log('Job auto-saved with AI analysis');
      } catch (saveError) {
        console.warn('⚠️ Failed to auto-save analyzed job:', saveError);
      }

      if (this.projectsListUI) {
        this.projectsListUI.updateBadge();
      } else {
        this.projectsListUI = new ProjectsListUI(this.stateManager, modalBody, this.styleRoot);
        this.projectsListUI.updateBadge();
      }

      modalBody.innerHTML = renderAnalysis(analysis, false);
      attachCollapsibleListeners(modalBody);
    } catch (error) {
      console.warn('⚠️ Analysis error:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error && error.stack ? error.stack : String(error);

      modalBody.innerHTML = `
        <div class="upwork-buddy-error">
          ❌ Error: ${escapeHtml(errorMessage)}
          <br><br>
          Make sure the Upwork Buddy API is running on <strong>${escapeHtml(CONFIG.apiBaseUrl)}</strong>
          <br>
          <small>Current environment: <strong>${escapeHtml(CONFIG.env)}</strong></small>
          <br><br>
          <details>
            <summary>Technical Details</summary>
            <pre style="font-size: 11px; overflow: auto;">${escapeHtml(errorStack)}</pre>
          </details>
        </div>
      `;
    }
  }

  private openProfileConfig(): void {
    this.modal.open();
    const modalBody = this.modal.getBody();

    if (!this.profileConfigUI) {
      this.profileConfigUI = new ProfileConfigUI(this.stateManager, modalBody);
    }

    this.profileConfigUI.render();
  }

  private showProjectsList(): void {
    this.modal.open();
    const modalBody = this.modal.getBody();

    if (!this.projectsListUI) {
      this.log('ProjectsListUI not instantiated; creating before render');
      this.projectsListUI = new ProjectsListUI(this.stateManager, modalBody, this.styleRoot);
    }

    this.log('Rendering projects list modal');
    this.projectsListUI.render();
  }

  private async showJobHistory(): Promise<void> {
    this.modal.open();
    const modalBody = this.modal.getBody();

    modalBody.innerHTML = '<div class="upwork-buddy-loading">📋 Loading job history...</div>';

    try {
      const jobs = await this.stateManager.loadSavedJobs();

      this.jobHistoryPanel = new JobHistoryPanel(
        modalBody,
        (job: SavedJob) => this.viewSavedJob(job),
        (id: number) => this.deleteSavedJob(id),
      );

      this.jobHistoryPanel.render(jobs);
    } catch (error) {
      console.error('❌ Failed to load job history:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      modalBody.innerHTML = `
        <div class="upwork-buddy-error">
          ❌ Failed to load job history: ${escapeHtml(errorMessage)}
        </div>
      `;
    }
  }

  private viewSavedJob(job: SavedJob): void {
    const modalBody = this.modal.getBody();
    const analysis = {
      proposal: job.proposal,
      time_estimate: job.time_estimate,
      execution_prompt: job.execution_prompt,
      tone_analysis: job.tone_analysis,
    };

    modalBody.innerHTML = `
      <button type="button" class="upwork-buddy-secondary-btn" style="background: #108ee9; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; margin-bottom: 16px;" id="upwork-buddy-back-to-history">
        ← Back to Job History
      </button>
      <h3 style="margin-top: 0; color: #14a800;">${escapeHtml(job.job_title)}</h3>
      <div class="upwork-buddy-project-meta" style="margin-bottom: 16px;">
        <span>💰 ${escapeHtml(job.budget || 'Not specified')}</span>
        <span>🛠️ ${escapeHtml(job.skills || 'Not specified')}</span>
      </div>
      ${renderAnalysis(analysis, true)}
    `;

    attachCollapsibleListeners(modalBody);
    const backBtn = modalBody.querySelector('#upwork-buddy-back-to-history');
    backBtn?.addEventListener('click', () => this.showJobHistory());
  }

  private async deleteSavedJob(id: number): Promise<void> {
    try {
      await this.stateManager.deleteJobFromHistory(id);
      const jobs = this.stateManager.getSavedJobs();
      if (this.jobHistoryPanel) {
        this.jobHistoryPanel.render(jobs);
      }
    } catch (error) {
      console.error('❌ Failed to delete job:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      alert(`Failed to delete job: ${errorMessage}`);
    }
  }

  private showTemplateBrowser(): void {
    this.modal.open();
    const modalBody = this.modal.getBody();
    this.templateBrowser = new TemplateBrowser(this.apiClient, modalBody);
    this.templateBrowser.render();
  }

  private log(message: string, payload?: Record<string, unknown>): void {
    if (payload) {
      console.log(this.logPrefix, message, payload);
      return;
    }
    console.log(this.logPrefix, message);
  }
}
