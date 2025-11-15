/**
 * Profile configuration UI component
 */

import type { ProfileState, PortfolioItem } from '../types';
import { StateManager } from '../state';
import { escapeHtml } from '../utils';

export class ProfileConfigUI {
  constructor(
    private stateManager: StateManager,
    private modalBody: HTMLDivElement
  ) {}

  /**
   * Render the configuration panel
   */
  render(): void {
    const profile = this.stateManager.getProfile();
    const portfolioItemsHTML = profile.portfolioItems?.length 
      ? profile.portfolioItems.map(item => `
          <div style="margin-bottom: 12px; padding: 12px; background: #f9f9f9; border-radius: 6px;">
            <strong>${escapeHtml(item.title || 'Untitled')}</strong><br>
            ${item.link ? `<a href="${escapeHtml(item.link)}" target="_blank" style="color: #108ee9; text-decoration: none;">${escapeHtml(item.link)}</a><br>` : ''}
            ${item.description ? `<span style="color: #666; font-size: 13px;">${escapeHtml(item.description)}</span>` : ''}
          </div>
        `).join('')
      : '<p style="color: #999; font-style: italic;">No portfolio items added yet.</p>';

    this.modalBody.innerHTML = `
      <div class="upwork-buddy-section">
        <div class="upwork-buddy-section-header" onclick="this.parentElement.querySelector('.upwork-buddy-section-content').classList.toggle('open'); this.querySelector('.upwork-buddy-section-toggle').classList.toggle('open');">
          <h4>📋 View Current Profile</h4>
          <span class="upwork-buddy-section-toggle">▼</span>
        </div>
        <div class="upwork-buddy-section-content">
          <div class="upwork-buddy-section-body">
            <h4 style="margin-top: 0; color: #14a800; font-size: 14px;">Profile Description</h4>
            <p style="white-space: pre-wrap; color: #333; font-size: 14px;">${escapeHtml(profile.description || 'No description saved.')}</p>
            
            <h4 style="color: #14a800; font-size: 14px;">Skills</h4>
            <p style="color: #333; font-size: 14px;">${escapeHtml(profile.skills || 'No skills saved.')}</p>
            
            <h4 style="color: #14a800; font-size: 14px;">Portfolio Items</h4>
            ${portfolioItemsHTML}
          </div>
        </div>
      </div>

      <div class="upwork-buddy-section">
        <div class="upwork-buddy-section-header">
          <h4>✏️ Edit Profile Settings</h4>
        </div>
        <div class="upwork-buddy-section-content open">
          <div class="upwork-buddy-section-body">
            <label for="upwork-buddy-profile-description">Profile Description</label>
            <textarea id="upwork-buddy-profile-description" class="upwork-buddy-portfolio-input" rows="4" placeholder="Summarize your experience"></textarea>
            <label for="upwork-buddy-profile-skills">Skills (comma-separated)</label>
            <input id="upwork-buddy-profile-skills" class="upwork-buddy-portfolio-input" type="text" placeholder="Go, React, Node.js, ...">
          </div>
        </div>
      </div>
      <div class="upwork-buddy-section">
        <div class="upwork-buddy-section-header" style="display:flex; justify-content:space-between; align-items:center;">
          <h4>Portfolio Items</h4>
          <button type="button" id="upwork-buddy-add-portfolio-item" class="upwork-buddy-add-portfolio-item-btn">Add item</button>
        </div>
        <div class="upwork-buddy-section-content open">
          <div class="upwork-buddy-section-body" id="upwork-buddy-portfolio-items-list"></div>
        </div>
      </div>
      <div id="upwork-buddy-profile-status" class="upwork-buddy-profile-status" aria-live="polite"></div>
      <div class="upwork-buddy-config-actions">
        <button type="button" class="upwork-buddy-save-profile-btn">Save profile</button>
      </div>
    `;

    this.attachEventListeners();
    this.populateFields();
    this.renderPortfolioItems();
  }

  private attachEventListeners(): void {
    const addBtn = document.getElementById('upwork-buddy-add-portfolio-item');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        this.addPortfolioItem();
        this.setStatus('');
      });
    }

    const saveBtn = this.modalBody.querySelector('.upwork-buddy-save-profile-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => this.handleSave());
    }

    const portfolioList = document.getElementById('upwork-buddy-portfolio-items-list');
    if (portfolioList) {
      portfolioList.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).matches('.upwork-buddy-remove-portfolio-item')) {
          const parent = (e.target as HTMLElement).closest('.upwork-buddy-portfolio-item');
          if (parent) parent.remove();
        }
      });
    }
  }

  private populateFields(): void {
    const profile = this.stateManager.getProfile();
    const descField = document.getElementById('upwork-buddy-profile-description') as HTMLTextAreaElement;
    const skillsField = document.getElementById('upwork-buddy-profile-skills') as HTMLInputElement;

    if (descField) descField.value = profile.description || '';
    if (skillsField) skillsField.value = profile.skills || '';
  }

  private renderPortfolioItems(): void {
    const container = document.getElementById('upwork-buddy-portfolio-items-list');
    if (!container) return;

    container.innerHTML = '';
    const profile = this.stateManager.getProfile();
    const items = profile.portfolioItems || [];

    if (items.length === 0) {
      const hint = document.createElement('p');
      hint.className = 'upwork-buddy-portfolio-hint';
      hint.textContent = 'Add portfolio highlights that showcase your best work.';
      container.appendChild(hint);
      return;
    }

    items.forEach(item => this.addPortfolioItem(item));
  }

  private addPortfolioItem(item: PortfolioItem = { title: '', link: '', description: '' }): void {
    const container = document.getElementById('upwork-buddy-portfolio-items-list');
    if (!container) return;

    const hint = container.querySelector('.upwork-buddy-portfolio-hint');
    if (hint) hint.remove();

    const wrapper = document.createElement('div');
    wrapper.className = 'upwork-buddy-portfolio-item';
    wrapper.innerHTML = `
      <label>Title</label>
      <input type="text" class="upwork-buddy-portfolio-title upwork-buddy-portfolio-input" value="${escapeHtml(item.title || '')}">
      <label>Link</label>
      <input type="text" class="upwork-buddy-portfolio-link upwork-buddy-portfolio-input" value="${escapeHtml(item.link || '')}">
      <label>Description</label>
      <textarea class="upwork-buddy-portfolio-description upwork-buddy-portfolio-input">${escapeHtml(item.description || '')}</textarea>
      <button type="button" class="upwork-buddy-remove-portfolio-item">Remove</button>
    `;

    container.appendChild(wrapper);
  }

  private gatherProfile(): ProfileState {
    const descField = document.getElementById('upwork-buddy-profile-description') as HTMLTextAreaElement;
    const skillsField = document.getElementById('upwork-buddy-profile-skills') as HTMLInputElement;
    const portfolioNodes = document.querySelectorAll('.upwork-buddy-portfolio-item');

    const items: PortfolioItem[] = [];
    portfolioNodes.forEach((node) => {
      const title = (node.querySelector('.upwork-buddy-portfolio-title') as HTMLInputElement)?.value.trim() || '';
      const link = (node.querySelector('.upwork-buddy-portfolio-link') as HTMLInputElement)?.value.trim() || '';
      const description = (node.querySelector('.upwork-buddy-portfolio-description') as HTMLTextAreaElement)?.value.trim() || '';

      if (title || link || description) {
        items.push({ title, link, description });
      }
    });

    return {
      description: descField?.value || '',
      skills: skillsField?.value || '',
      portfolioItems: items
    };
  }

  private async handleSave(): Promise<void> {
    const profile = this.gatherProfile();
    this.setStatus('Saving profile...');

    try {
      await this.stateManager.saveProfile(profile);
      this.renderPortfolioItems();
      this.setStatus('Profile saved successfully.', false);
    } catch (error) {
      console.error('Failed to save profile:', error);
      this.setStatus(`Failed to save profile: ${(error as Error).message}`, true);
    }
  }

  private setStatus(message: string, isError = false): void {
    const status = document.getElementById('upwork-buddy-profile-status');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? '#c82333' : '#14a800';
  }
}
