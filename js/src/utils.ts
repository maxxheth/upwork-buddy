/**
 * Utility functions for HTML rendering and DOM manipulation
 */

import type { AnalysisResponse } from './types';

/**
 * Escape HTML to prevent injection
 */
export function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Render a value (handles objects, arrays, strings, etc.)
 */
export function renderValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) {
    return '<em style="color: #999;">null</em>';
  }

  if (typeof value === 'boolean') {
    return `<strong>${value}</strong>`;
  }

  if (typeof value === 'number') {
    return `<strong>${value}</strong>`;
  }

  if (typeof value === 'string') {
    // Check if it's a JSON string
    try {
      const parsed = JSON.parse(value);
      return renderValue(parsed, depth);
    } catch (e) {
      // Escape HTML and preserve line breaks
      const escaped = escapeHtml(value);
      return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
    }
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '<em style="color: #999;">Empty array</em>';
    return `<ul>${value.map(item => `<li>${renderValue(item, depth + 1)}</li>`).join('')}</ul>`;
  }

  if (typeof value === 'object') {
    let html = '';
    Object.entries(value).forEach(([key, val]) => {
      const displayKey = escapeHtml(key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()));
      html += `
        <div class="upwork-buddy-section" style="margin-left: ${depth * 10}px;">
          <div class="upwork-buddy-section-header" onclick="this.parentElement.querySelector('.upwork-buddy-section-content').classList.toggle('open'); this.querySelector('.upwork-buddy-section-toggle').classList.toggle('open');">
            <h4 style="font-size: ${15 - depth}px;">${displayKey}</h4>
            <span class="upwork-buddy-section-toggle">▼</span>
          </div>
          <div class="upwork-buddy-section-content">
            <div class="upwork-buddy-section-body">
              ${renderValue(val, depth + 1)}
            </div>
          </div>
        </div>
      `;
    });
    return html;
  }

  return escapeHtml(String(value));
}

/**
 * Render analysis results
 */
export function renderAnalysis(analysis: AnalysisResponse, showCachedIndicator = false): string {
  console.log('🎨 Rendering analysis with keys:', Object.keys(analysis));

  let html = '';

  // Show cached indicator if applicable
  if (showCachedIndicator && analysis._cached) {
    html += `<div style="background: #fff3cd; color: #856404; padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px;">
      📦 Loaded from cache (no API call made)
    </div>`;
  }

  // Icons for each section
  const icons: Record<string, string> = {
    'proposal': '📝',
    'spec_sheet_prompt': '📋',
    'time_estimate': '⏱️',
    'workload_division': '🤖',
    'questions_for_client': '❓',
    'tips_and_advice': '💡',
    'tone_analysis': '🎯'
  };

  // Default open sections
  const defaultOpen = ['proposal', 'time_estimate'];

  // Render each top-level field (skip internal fields)
  Object.entries(analysis).forEach(([key, value]) => {
    if (key.startsWith('_')) return; // Skip internal fields like _cached

    console.log(`📄 Rendering section: ${key}`);

    const displayName = key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    const icon = icons[key] || '📄';
    const isOpen = defaultOpen.includes(key);

    try {
      const renderedContent = renderValue(value, 0);
      html += `
        <div class="upwork-buddy-section">
          <div class="upwork-buddy-section-header" onclick="this.parentElement.querySelector('.upwork-buddy-section-content').classList.toggle('open'); this.querySelector('.upwork-buddy-section-toggle').classList.toggle('open');">
            <h4>${icon} ${escapeHtml(displayName)}</h4>
            <span class="upwork-buddy-section-toggle ${isOpen ? 'open' : ''}">▼</span>
          </div>
          <div class="upwork-buddy-section-content ${isOpen ? 'open' : ''}">
            <div class="upwork-buddy-section-body">
              ${renderedContent}
            </div>
          </div>
        </div>
      `;
    } catch (error) {
      console.error(`❌ Error rendering section ${key}:`, error);
      html += `
        <div class="upwork-buddy-section">
          <div class="upwork-buddy-section-header">
            <h4>${icon} ${escapeHtml(displayName)} (Error)</h4>
          </div>
          <div class="upwork-buddy-section-content open">
            <div class="upwork-buddy-section-body">
              <p style="color: red;">Error rendering this section: ${escapeHtml((error as Error).message)}</p>
            </div>
          </div>
        </div>
      `;
    }
  });

  return html;
}

/**
 * Format time ago string
 */
export function getTimeAgo(date: Date): string {
  const seconds = Math.floor((new Date().getTime() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)} days ago`;

  return date.toLocaleDateString();
}
