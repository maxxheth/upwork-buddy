/**
 * Utility functions for HTML rendering and DOM manipulation
 */

import type { AnalysisResponse } from './types';

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape HTML to prevent injection (including single and double quotes in attributes)
 */
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

/**
 * Validate and normalize HTTP/HTTPS URLs; returns null for javascript:, data:, or invalid URLs.
 */
export function sanitizeHttpUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Attach CSP-safe click listeners to collapsible section headers inside a container.
 */
export function attachCollapsibleListeners(container: HTMLElement): void {
  const headers = container.querySelectorAll<HTMLElement>(
    '.upwork-buddy-section-header[data-collapsible="true"]',
  );
  headers.forEach((header) => {
    if (header.dataset.collapsibleBound === 'true') return;
    header.dataset.collapsibleBound = 'true';
    header.addEventListener('click', () => {
      const section = header.parentElement;
      const content =
        section?.querySelector(':scope > .upwork-buddy-section-content') ??
        header.nextElementSibling;
      const toggle = header.querySelector('.upwork-buddy-section-toggle');
      content?.classList.toggle('open');
      toggle?.classList.toggle('open');
    });
  });
}

/**
 * Render a value (handles objects, arrays, strings, etc.)
 */
const MAX_RENDER_DEPTH = 32;

export function renderValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) {
    return '<em style="color: #999;">null</em>';
  }
  if (depth >= MAX_RENDER_DEPTH) {
    if (typeof value === 'object') {
      return '<em style="color: #999;">[Max depth exceeded]</em>';
    }
    return escapeHtml(String(value));
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
      // Only treat as JSON if it's an object or array, not just a string
      if (typeof parsed === 'object' && parsed !== null) {
        return renderValue(parsed, depth);
      }
    } catch {
      // Not valid JSON, continue to render as string
    }

    // Escape HTML and preserve line breaks
    const escaped = escapeHtml(value);
    return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '<em style="color: #999;">Empty array</em>';
    return `<ul>${value.map((item) => `<li>${renderValue(item, depth + 1)}</li>`).join('')}</ul>`;
  }

  if (typeof value === 'object') {
    let html = '';
    Object.entries(value).forEach(([key, val]) => {
      const displayKey = escapeHtml(
        key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
      );
      html += `
        <div class="upwork-buddy-section" style="margin-left: ${depth * 10}px;">
          <div class="upwork-buddy-section-header" data-collapsible="true">
            <h4 style="font-size: ${Math.max(11, 15 - depth)}px;">${displayKey}</h4>
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
  console.log('🎨 renderAnalysis: Starting render with keys:', Object.keys(analysis));
  console.log('🎨 renderAnalysis: Field lengths:', {
    proposal: analysis.proposal?.length || 0,
    execution_prompt: analysis.execution_prompt?.length || 0,
    time_estimate: analysis.time_estimate?.length || 0,
    workload_division: analysis.workload_division?.length || 0,
    questions_for_client: analysis.questions_for_client?.length || 0,
    tips_and_advice: analysis.tips_and_advice?.length || 0,
    tone_analysis: analysis.tone_analysis?.length || 0,
  });

  let html = '';

  // Show cached indicator if applicable
  if (showCachedIndicator && analysis._cached) {
    html += `<div style="background: #fff3cd; color: #856404; padding: 12px; border-radius: 8px; margin-bottom: 16px; font-size: 13px;">
      📦 Loaded from cache (no API call made)
    </div>`;
  }

  // Icons for each section
  const icons: Record<string, string> = {
    proposal: '📝',
    execution_prompt: '⚡',
    time_estimate: '⏱️',
    workload_division: '🤖',
    questions_for_client: '❓',
    tips_and_advice: '💡',
    tone_analysis: '🎯',
  };

  // Default open sections
  const defaultOpen = ['proposal', 'time_estimate'];

  // Render each top-level field (skip internal fields)
  Object.entries(analysis).forEach(([key, value]) => {
    if (key.startsWith('_')) return; // Skip internal fields like _cached

    console.log(`📄 Rendering section: ${key}`);

    const displayName = key.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
    const icon = Object.hasOwn(icons, key) ? icons[key] : '📄';
    const isOpen = defaultOpen.includes(key);

    try {
      const renderedContent = renderValue(value, 0);
      html += `
        <div class="upwork-buddy-section">
          <div class="upwork-buddy-section-header" data-collapsible="true">
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
