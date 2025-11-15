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
import { renderAnalysis, escapeHtml } from './utils';
import { CONFIG } from './types';

class UpworkBuddy {
  private stateManager: StateManager;
  private apiClient: ApiClient;
  private jobExtractor: JobExtractor;
  private modal: Modal;
  private buttonManager: ButtonManager;
  private profileConfigUI: ProfileConfigUI | null = null;
  private projectsListUI: ProjectsListUI | null = null;

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
      () => this.showProjectsList()
    );

    // Initialize
    this.initialize();
  }

  private async initialize(): Promise<void> {
    // Load profile configuration
    await this.stateManager.loadProfile();

    // Initialize projects list UI to update badge if we have cached projects
    if (this.stateManager.getCacheSize() > 0) {
      const modalBody = this.modal.getBody();
      this.projectsListUI = new ProjectsListUI(this.stateManager, modalBody);
      this.projectsListUI.updateBadge();
    }

    // Watch for job drawer to appear
    this.watchForDrawer();

    console.log('✅ Upwork Buddy activated! Open a job to see the Analyze button.');
  }

  /**
   * Watch for job details drawer to appear
   */
  private watchForDrawer(): void {
    console.log('👀 Watching for job details drawer...');

    const observer = new MutationObserver(() => {
      const drawer = document.querySelector('.job-details-content');

      if (drawer && !drawer.hasAttribute('data-upwork-buddy')) {
        console.log('✅ Job details drawer found!');
        this.buttonManager.showAnalyzeButton();
        drawer.setAttribute('data-upwork-buddy', 'true');
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
      this.stateManager.cacheAnalysis(jobInfo, analysis);

      // Update projects list badge
      if (this.projectsListUI) {
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
          Make sure the Upwork Buddy API is running on ${CONFIG.apiBaseUrl}
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
      this.projectsListUI = new ProjectsListUI(this.stateManager, modalBody);
    }

    this.projectsListUI.render();
  }
}

// Initialize the application when the script loads
(function() {
  'use strict';
  new UpworkBuddy();
})();
