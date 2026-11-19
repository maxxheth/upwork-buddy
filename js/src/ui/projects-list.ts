/**
 * Projects list UI component for viewing cached analyses
 */

import type { StateManager } from '../state';
import { attachCollapsibleListeners, escapeHtml, getTimeAgo, renderAnalysis } from '../utils';

export class ProjectsListUI {
  constructor(
    private stateManager: StateManager,
    private modalBody: HTMLDivElement,
  ) {
    this.log('Initialized ProjectsListUI');
  }

  private log(message: string, payload?: unknown): void {
    if (payload) {
      console.log('[UpworkBuddy][ProjectsListUI]', message, payload);
      return;
    }
    console.log('[UpworkBuddy][ProjectsListUI]', message);
  }

  /**
   * Render the projects list
   */
  render(): void {
    const projects = this.stateManager.getAllCachedJobs();
    this.log('Rendering projects list', {
      total: projects.length,
      keys: projects.map((p) => p.cacheKey),
    });

    let html = '<h3 style="margin-top: 0; color: #14a800;">📋 Analyzed Projects</h3>';

    if (projects.length === 0) {
      html +=
        '<p style="text-align: center; color: #999; padding: 40px;">No projects analyzed yet. Click "Analyze Job" on a job posting to get started.</p>';
      html += `
        <div class="upwork-buddy-cache-actions">
          <button class="upwork-buddy-secondary-btn js-upwork-buddy-import">⬆️ Import JSON</button>
        </div>
      `;
    } else {
      html += '<ul class="upwork-buddy-projects-list">';

      projects.forEach((data) => {
        const { jobInfo, timestamp, cacheKey } = data;
        const date = new Date(timestamp);
        const timeAgo = getTimeAgo(date);

        html += `
          <li class="upwork-buddy-project-item js-upwork-buddy-project" data-cache-key="${escapeHtml(cacheKey)}">
            <h4 class="upwork-buddy-project-title">${escapeHtml(jobInfo.title)}</h4>
            <div class="upwork-buddy-project-meta">
              <span>💰 ${escapeHtml(jobInfo.budget)}</span>
              <span>🔧 ${escapeHtml(jobInfo.skills.split(',').slice(0, 3).join(','))}</span>
            </div>
            <div class="upwork-buddy-project-timestamp">Analyzed ${escapeHtml(timeAgo)}</div>
          </li>
        `;
      });

      html += '</ul>';
      html += `
        <div class="upwork-buddy-cache-actions">
          <button class="upwork-buddy-secondary-btn js-upwork-buddy-export">⬇️ Export JSON</button>
          <button class="upwork-buddy-secondary-btn js-upwork-buddy-import">⬆️ Import JSON</button>
          <button class="upwork-buddy-clear-cache-btn js-upwork-buddy-clear">🗑️ Clear All Cached Projects</button>
        </div>
      `;
    }

    this.modalBody.innerHTML = html;
    this.attachCacheActionHandlers();
    this.attachProjectHandlers();
  }

  /**
   * Show a specific project's analysis
   */
  private showProject(cacheKey: string): void {
    this.log('Request to show project', { cacheKey });
    const data = this.stateManager.getCachedJobByKey(cacheKey);

    if (!data) {
      console.error('[UpworkBuddy][ProjectsListUI] ❌ Project not found in cache');
      return;
    }

    const analysis = { ...data.analysis, _cached: true };

    this.modalBody.innerHTML = `
      <button class="upwork-buddy-secondary-btn js-upwork-buddy-back" style="background: #108ee9; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; margin-bottom: 16px;">
        ← Back to Projects List
      </button>
      <h3 style="margin-top: 0; color: #14a800;">${escapeHtml(data.jobInfo.title)}</h3>
      ${renderAnalysis(analysis, true)}
    `;

    attachCollapsibleListeners(this.modalBody);
    const backBtn = this.modalBody.querySelector<HTMLButtonElement>('.js-upwork-buddy-back');
    backBtn?.addEventListener('click', () => this.render());
  }

  private attachCacheActionHandlers(): void {
    const exportBtn = this.modalBody.querySelector<HTMLButtonElement>('.js-upwork-buddy-export');
    const importBtn = this.modalBody.querySelector<HTMLButtonElement>('.js-upwork-buddy-import');
    const clearBtn = this.modalBody.querySelector<HTMLButtonElement>('.js-upwork-buddy-clear');

    exportBtn?.addEventListener('click', () => this.exportCache());
    importBtn?.addEventListener('click', () => this.importCache());
    clearBtn?.addEventListener('click', () => this.clearCache());
  }

  private attachProjectHandlers(): void {
    const projectItems = this.modalBody.querySelectorAll<HTMLLIElement>('.js-upwork-buddy-project');
    projectItems.forEach((item) => {
      item.addEventListener('click', () => {
        const cacheKey = item.getAttribute('data-cache-key');
        if (cacheKey) {
          this.showProject(cacheKey);
        }
      });
    });
  }

  /**
   * Clear cache
   */
  private async clearCache(): Promise<void> {
    if (confirm('Are you sure you want to clear all cached project analyses?')) {
      this.log('User confirmed cache clear');
      await this.stateManager.clearCache();
      this.log('Cache cleared; re-rendering list');
      this.render();
      this.updateBadge();
    }
  }

  private exportCache(): void {
    const snapshot = this.stateManager.getCacheSnapshot();
    this.log('Export cache requested', { count: snapshot.length });
    if (snapshot.length === 0) {
      alert('No cached analyses available to export.');
      return;
    }

    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      items: snapshot,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `upwork-buddy-cache-${Date.now()}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    this.log('Cache export complete');
  }

  private importCache(): void {
    this.log('Import cache requested');
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0];
        if (!file) {
          this.log('Import cancelled (no file selected)');
          return;
        }

        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const text = typeof reader.result === 'string' ? reader.result : '';
            if (!text) {
              throw new Error('File was empty or unreadable');
            }
            const parsed = JSON.parse(text);
            const count = await this.stateManager.importCacheFromJson(parsed);
            this.log('Import completed', { count });
            if (count > 0) {
              this.render();
              this.updateBadge();
              alert(`Imported ${count} cached analyses.`);
            } else {
              alert('No valid cached analyses found in the selected file.');
            }
          } catch (error) {
            console.error('[UpworkBuddy][ProjectsListUI] ❌ Failed to import cache', error);
            alert(
              `Failed to import cache: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        };
        reader.readAsText(file);
      },
      { once: true },
    );

    input.click();
  }

  /**
   * Update the badge count on the View Projects button
   */
  updateBadge(): void {
    const btn = document.getElementById('upwork-buddy-view-projects-btn');
    if (btn) {
      const badge = btn.querySelector('.badge');
      const size = this.stateManager.getCacheSize();
      this.log('Updating badge', { size });
      if (badge) {
        badge.textContent = size.toString();
      }

      btn.classList.add('visible');
    }
  }
}
