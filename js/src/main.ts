/**
 * Main entry point for Upwork Buddy bookmarklet
 * Initializes all modules and wires up the application
 */

import { injectStyles } from './styles';
import { StateManager } from './state';
import { ApiClient } from './api';
import { JobExtractor } from './job-extractor';
import { Modal } from './ui/modal';
import { ButtonManager } from './ui/buttons';
import { ProfileConfigUI } from './ui/profile-config';
import { ProjectsListUI } from './ui/projects-list';
import { JobHistoryPanel } from './ui/job-history';
import { TemplateBrowser } from './ui/template-browser';
import { renderAnalysis, escapeHtml } from './utils';
import { detectEnvironment, loadConfig, CONFIG } from './types';
import type { SavedJob } from './types';
import { StorageAdapter } from './storage';

class UpworkBuddy {
  private stateManager: StateManager;
  private apiClient: ApiClient;
  private jobExtractor: JobExtractor;
  private modal: Modal;
  private buttonManager: ButtonManager;
  private profileConfigUI: ProfileConfigUI | null = null;
  private projectsListUI: ProjectsListUI | null = null;
  private jobHistoryPanel: JobHistoryPanel | null = null;
  private templateBrowser: TemplateBrowser | null = null;
  private logPrefix = '[UpworkBuddy][Main]';

  constructor() {
    this.stateManager = new StateManager();
    this.apiClient = new ApiClient();
    this.jobExtractor = new JobExtractor();
    
    // Inject styles first
    injectStyles();

    // Create modal
    this.modal = new Modal();

    // Create buttons with handlers
    this.buttonManager = new ButtonManager(
      () => this.handleAnalyze(),
      () => this.openProfileConfig(),
      () => this.showProjectsList(),
      () => this.showJobHistory(),
      () => this.showTemplateBrowser()
    );

    // Initialize
    this.initialize();
  }

  private async initialize(): Promise<void> {
    // ── Environment-aware config resolution ──
    const storage = new StorageAdapter();

    // Check for an explicit env override stored in extension storage.
    // This allows APP_ENV=local to take effect even when running on
    // upwork.com (where hostname detection would resolve to "production").
    const envOverride = await storage.getEnvOverride();
    const customOverrides = await storage.getCustomConfig();

    const detectedEnv = detectEnvironment();
    // envOverride takes highest priority, then detected, then default
    const resolvedEnv = envOverride ?? undefined;
    const resolvedConfig = loadConfig(resolvedEnv, customOverrides ?? undefined);

    // PATCH: Override the module-level CONFIG object so all existing references
    // (ApiClient, StateManager, etc.) pick up the resolved values without
    // requiring constructor injection.
    Object.assign(CONFIG, resolvedConfig);

    console.log(`🌍 Upwork Buddy starting in "${resolvedConfig.env}" environment (detected: "${detectedEnv}"${envOverride ? `, override: "${envOverride}"` : ''})`);
    if (customOverrides) {
      console.log('🔧 Custom config overrides applied:', customOverrides);
    }

    this.log('Initializing extension...');
    await this.stateManager.initializeStorage();
    this.log('Storage initialized', { cacheSize: this.stateManager.getCacheSize() });
    // Load profile configuration
    await this.stateManager.loadProfile();

    // Initialize projects list UI to update badge if we have cached projects
    if (this.stateManager.getCacheSize() > 0) {
      this.log('Cached projects detected, bootstrapping ProjectsListUI');
      const modalBody = this.modal.getBody();
      this.projectsListUI = new ProjectsListUI(this.stateManager, modalBody);
      this.projectsListUI.updateBadge();
      this.log('ProjectsListUI ready with initial badge update');
    }

    // Run selector health check and show warning if needed
    this.runHealthCheck();

    // Watch for job drawer to appear
    this.watchForDrawer();

    console.log('✅ Upwork Buddy activated! Open a job to see the Analyze button.');
  }

  /**
   * Run the selector health check and show a warning banner if any fields are broken.
   */
  private runHealthCheck(): void {
    const results = this.jobExtractor.healthCheck();
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

  /**
   * Show a dismissible warning banner on the page when some selectors are broken.
   */
  private showHealthWarning(brokenFields: string[]): void {
    // Don't show the warning more than once per session
    if (document.getElementById('upwork-buddy-health-warning')) {
      return;
    }

    const banner = document.createElement('div');
    banner.id = 'upwork-buddy-health-warning';
    banner.className = 'upwork-buddy-health-warning';
    banner.innerHTML = `
      <span>⚠️ Upwork Buddy: Some selectors need updating (${escapeHtml(brokenFields.join(', '))}). Job extraction may be incomplete.</span>
      <button class="upwork-buddy-health-dismiss" title="Dismiss for this session">✕</button>
    `;

    banner.querySelector('.upwork-buddy-health-dismiss')?.addEventListener('click', () => {
      banner.remove();
    });

    document.body.appendChild(banner);
  }

  /**
   * Watch for job details drawer to appear and disappear
   */
  private watchForDrawer(): void {
    console.log('👀 Watching for job details drawer...');

    const observer = new MutationObserver(() => {
      const drawer = document.querySelector('.job-details-content');

      if (drawer && !drawer.hasAttribute('data-upwork-buddy')) {
        console.log('✅ Job details drawer found!');
        this.buttonManager.showContainer();
        drawer.setAttribute('data-upwork-buddy', 'true');
      } else if (!drawer) {
        // Drawer was closed or removed
        console.log('👋 Job details drawer closed');
        this.buttonManager.hideContainer();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    console.log('✅ Drawer observer activated');
  }

  /**
   * Handle analyze job action
   */
  private async handleAnalyze(): Promise<void> {
    this.modal.open();
    const modalBody = this.modal.getBody();

    const drawer = this.jobExtractor.findJobDrawer();
    if (!drawer) {
      modalBody.innerHTML = `
        <div class="upwork-buddy-error">
          ❌ Could not find the open job details drawer. Open a job posting and try again.
        </div>
      `;
      return;
    }

    modalBody.innerHTML = '<div class="upwork-buddy-loading">🤖 Analyzing job posting with AI...</div>';

    try {
      const jobInfo = this.jobExtractor.extractJobInfo(drawer);
      console.log('📊 Extracting job info from current drawer:', jobInfo);

      const profile = this.stateManager.getProfile();
      const profileDescription = profile.description?.trim() || CONFIG.defaultProfile;
      const profileSkills = profile.skills?.trim() || CONFIG.defaultSkills;

      const analysis = await this.apiClient.analyzeJob(jobInfo, profileDescription, profileSkills);
      console.log('✅ Got analysis response:', analysis);

      // Cache the result
      await this.stateManager.cacheAnalysis(jobInfo, analysis);
      this.log('Analysis cached', { cacheSize: this.stateManager.getCacheSize() });

      // Auto-save job to history via API
      try {
        await this.stateManager.saveJobToHistory({
          job_title: jobInfo.title,
          job_description: jobInfo.description,
          contract_type: jobInfo.contractType,
          budget: jobInfo.budget,
          rate_range: jobInfo.rateRange,
          rate_min: jobInfo.rateMin,
          rate_max: jobInfo.rateMax,
          budget_amount: jobInfo.budgetAmount,
          experience_level: jobInfo.experienceLevel,
          skills: jobInfo.skills,
          proposal: analysis.proposal || '',
          time_estimate: analysis.time_estimate || '',
          execution_prompt: analysis.execution_prompt || '',
          tone_analysis: analysis.tone_analysis || ''
        });
        this.log('Job auto-saved to history');
      } catch (saveError) {
        console.warn('⚠️ Failed to auto-save job to history:', saveError);
      }

      // Update projects list badge
      if (this.projectsListUI) {
        this.log('Updating badge after analysis');
        this.projectsListUI.updateBadge();
      } else {
        this.log('ProjectsListUI missing when trying to update badge; creating instance now');
        const modalBody = this.modal.getBody();
        this.projectsListUI = new ProjectsListUI(this.stateManager, modalBody);
        this.projectsListUI.updateBadge();
      }

      modalBody.innerHTML = renderAnalysis(analysis, false);
    } catch (error) {
      console.error('❌ Analysis error:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error && error.stack ? error.stack : String(error);
      
      modalBody.innerHTML = `
        <div class="upwork-buddy-error">
          ❌ Error: ${escapeHtml(errorMessage)}
          <br><br>
          Make sure the Upwork Buddy API is running on <strong>${escapeHtml(CONFIG.apiBaseUrl)}</strong>
          <br>
          <small>Current environment: <strong>${escapeHtml(CONFIG.env)}</strong> —
          open Profile Settings to switch to Local/Development, or run:
          <code>localStorage.setItem('upwork_buddy_env', 'local')</code> in the console.</small>
          <br><br>
          <details>
            <summary>Technical Details</summary>
            <pre style="font-size: 11px; overflow: auto;">${escapeHtml(errorStack)}</pre>
          </details>
        </div>
      `;
    }
  }

  /**
   * Open profile configuration modal
   */
  private openProfileConfig(): void {
    this.modal.open();
    const modalBody = this.modal.getBody();

    if (!this.profileConfigUI) {
      this.profileConfigUI = new ProfileConfigUI(this.stateManager, modalBody);
    }

    this.profileConfigUI.render();
  }

  /**
   * Show projects list modal
   */
  private showProjectsList(): void {
    this.modal.open();
    const modalBody = this.modal.getBody();

    if (!this.projectsListUI) {
      this.log('ProjectsListUI not instantiated; creating before render');
      this.projectsListUI = new ProjectsListUI(this.stateManager, modalBody);
    }

    this.log('Rendering projects list modal');
    this.projectsListUI.render();
  }

  /**
   * Show job history modal
   */
  private async showJobHistory(): Promise<void> {
    this.modal.open();
    const modalBody = this.modal.getBody();

    modalBody.innerHTML = '<div class="upwork-buddy-loading">📋 Loading job history...</div>';

    try {
      const jobs = await this.stateManager.loadSavedJobs();

      this.jobHistoryPanel = new JobHistoryPanel(
        modalBody,
        (job: SavedJob) => this.viewSavedJob(job),
        (id: number) => this.deleteSavedJob(id)
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

  /**
   * View a saved job's full analysis
   */
  private viewSavedJob(job: SavedJob): void {
    const modalBody = this.modal.getBody();
    const analysis = {
      proposal: job.proposal,
      time_estimate: job.time_estimate,
      execution_prompt: job.execution_prompt,
      tone_analysis: job.tone_analysis
    };

    modalBody.innerHTML = `
      <button class="upwork-buddy-secondary-btn" style="background: #108ee9; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; margin-bottom: 16px;" id="upwork-buddy-back-to-history">
        ← Back to Job History
      </button>
      <h3 style="margin-top: 0; color: #14a800;">${escapeHtml(job.job_title)}</h3>
      <div class="upwork-buddy-project-meta" style="margin-bottom: 16px;">
        <span>💰 ${escapeHtml(job.budget || 'Not specified')}</span>
        <span>🛠️ ${escapeHtml(job.skills || 'Not specified')}</span>
      </div>
      ${renderAnalysis(analysis, true)}
    `;

    const backBtn = modalBody.querySelector('#upwork-buddy-back-to-history');
    backBtn?.addEventListener('click', () => this.showJobHistory());
  }

  /**
   * Delete a saved job and refresh the list
   */
  private async deleteSavedJob(id: number): Promise<void> {
    try {
      await this.stateManager.deleteJobFromHistory(id);
      // Refresh the job history panel
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

  /**
   * Show the template browser for generating and downloading AI agents
   */
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

// Initialize the application when the script loads
(function() {
  'use strict';
  new UpworkBuddy();
})();