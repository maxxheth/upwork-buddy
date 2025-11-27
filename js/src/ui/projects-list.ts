/**
 * Projects list UI component for viewing cached analyses
 */

import type { StateManager } from '../state';
import { escapeHtml, getTimeAgo, renderAnalysis } from '../utils';

export class ProjectsListUI {
  constructor(
    private stateManager: StateManager,
    private modalBody: HTMLDivElement
  ) {
    // Expose global handlers for onclick attributes
    (window as any).upworkBuddyShowProject = this.showProject.bind(this);
    (window as any).upworkBuddyBackToList = this.render.bind(this);
    (window as any).upworkBuddyClearCache = this.clearCache.bind(this);
  }

  /**
   * Render the projects list
   */
  render(): void {
    let html = '<h3 style="margin-top: 0; color: #14a800;">📋 Analyzed Projects</h3>';

    const projects = this.stateManager.getAllCachedJobs();

    if (projects.length === 0) {
      html += '<p style="text-align: center; color: #999; padding: 40px;">No projects analyzed yet. Click "Analyze Job" on a job posting to get started.</p>';
    } else {
      html += '<ul class="upwork-buddy-projects-list">';

      projects.forEach((data) => {
        const { jobInfo, timestamp, cacheKey } = data;
        const date = new Date(timestamp);
        const timeAgo = getTimeAgo(date);

        // Escape quotes in cache key for onclick handler
        const escapedKey = cacheKey.replace(/'/g, "\\'").replace(/"/g, '\\"');

        html += `
          <li class="upwork-buddy-project-item" onclick="window.upworkBuddyShowProject(\`${escapedKey}\`)">
            <h4 class="upwork-buddy-project-title">${escapeHtml(jobInfo.title)}</h4>
            <div class="upwork-buddy-project-meta">
              <span>💰 ${escapeHtml(jobInfo.budget)}</span>
              <span>🔧 ${escapeHtml(jobInfo.skills.split(',').slice(0, 3).join(','))}</span>
            </div>
            <div class="upwork-buddy-project-timestamp">Analyzed ${timeAgo}</div>
          </li>
        `;
      });

      html += '</ul>';
      html += '<button class="upwork-buddy-clear-cache-btn" onclick="window.upworkBuddyClearCache()">🗑️ Clear All Cached Projects</button>';
    }

    this.modalBody.innerHTML = html;
  }

  /**
   * Show a specific project's analysis
   */
  private showProject(cacheKey: string): void {
    console.log('🔍 Looking up project with cache key:', cacheKey.substring(0, 50) + '...');
    const data = this.stateManager.getCachedJobByKey(cacheKey);

    if (!data) {
      console.error('❌ Project not found in cache');
      return;
    }

    const analysis = { ...data.analysis, _cached: true };

    this.modalBody.innerHTML = `
      <button onclick="window.upworkBuddyBackToList()" style="background: #108ee9; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; margin-bottom: 16px;">
        ← Back to Projects List
      </button>
      <h3 style="margin-top: 0; color: #14a800;">${escapeHtml(data.jobInfo.title)}</h3>
      ${renderAnalysis(analysis, true)}
    `;
  }

  /**
   * Clear cache
   */
  private async clearCache(): Promise<void> {
    if (confirm('Are you sure you want to clear all cached project analyses?')) {
      await this.stateManager.clearCache();
      this.render();
      this.updateBadge();
    }
  }

  /**
   * Update the badge count on the View Projects button
   */
  updateBadge(): void {
    const btn = document.getElementById('upwork-buddy-view-projects-btn');
    if (btn) {
      const badge = btn.querySelector('.badge');
      const size = this.stateManager.getCacheSize();
      if (badge) {
        badge.textContent = size.toString();
      }

      // Show button if we have analyzed jobs
      if (size > 0) {
        btn.classList.add('visible');
      } else {
        btn.classList.remove('visible');
      }
    }
  }
}
