/**
 * Job History UI component for viewing saved job analyses
 */

import type { SavedJob } from '../types';
import { escapeHtml, getTimeAgo } from '../utils';

export class JobHistoryPanel {
  private container: HTMLElement;
  private onJobSelect?: (job: SavedJob) => void;
  private onJobDelete?: (id: number) => Promise<void>;

  constructor(
    container: HTMLElement,
    onJobSelect?: (job: SavedJob) => void,
    onJobDelete?: (id: number) => Promise<void>,
  ) {
    this.container = container;
    this.onJobSelect = onJobSelect;
    this.onJobDelete = onJobDelete;
  }

  render(jobs: SavedJob[]): void {
    if (jobs.length === 0) {
      this.container.innerHTML = `
        <div class="upwork-buddy-empty-state">
          <p>📋 No saved jobs yet</p>
          <p style="font-size: 12px; color: #999;">Analyzed jobs will appear here</p>
        </div>
      `;
      return;
    }

    const jobCards = jobs.map((job) => this.renderJobCard(job)).join('');
    this.container.innerHTML = `
      <div class="upwork-buddy-job-history">
        <h3>📋 Job History (${jobs.length})</h3>
        <div class="upwork-buddy-job-list">
          ${jobCards}
        </div>
      </div>
    `;

    // Wire up event handlers after rendering
    this.container.querySelectorAll('[data-job-id]').forEach((card) => {
      const rawId = card.getAttribute('data-job-id');
      if (!rawId) return;
      const jobId = Number.parseInt(rawId, 10);
      const viewBtn = card.querySelector('.upwork-buddy-view-job');
      const deleteBtn = card.querySelector('.upwork-buddy-delete-job');
      const job = jobs.find((j) => j.id === jobId);

      if (viewBtn && job && this.onJobSelect) {
        const onSelect = this.onJobSelect;
        viewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          onSelect(job);
        });
      }

      if (deleteBtn && this.onJobDelete) {
        const onDelete = this.onJobDelete;
        deleteBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm('Delete this saved job?')) {
            await onDelete(jobId);
          }
        });
      }
    });
  }

  private renderJobCard(job: SavedJob): string {
    const timeAgo = getTimeAgo(new Date(job.created_at));
    return `
      <div class="upwork-buddy-job-card" data-job-id="${escapeHtml(String(job.id))}">
        <div class="upwork-buddy-job-card-header">
          <h4>${escapeHtml(job.job_title)}</h4>
          <span class="upwork-buddy-job-card-time">${escapeHtml(timeAgo)}</span>
        </div>
        <div class="upwork-buddy-job-card-details">
          <span>💰 ${escapeHtml(job.budget || 'Not specified')}</span>
          <span>🛠️ ${escapeHtml(job.skills || 'Not specified')}</span>
        </div>
        <div class="upwork-buddy-job-card-actions">
          <button class="upwork-buddy-view-job">View</button>
          <button class="upwork-buddy-delete-job">🗑️</button>
        </div>
      </div>
    `;
  }
}
