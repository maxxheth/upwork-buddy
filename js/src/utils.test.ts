import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisResponse } from './types';
import {
  attachCollapsibleListeners,
  escapeHtml,
  getTimeAgo,
  renderAnalysis,
  renderValue,
  sanitizeHttpUrl,
} from './utils';

describe('escapeHtml', () => {
  it('should escape HTML special characters', () => {
    const result = escapeHtml('<script>alert("xss")</script>');
    expect(result).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('should escape ampersands', () => {
    const result = escapeHtml('foo & bar');
    expect(result).toBe('foo &amp; bar');
  });

  it('should escape double and single quotes', () => {
    expect(escapeHtml('he said "hello"')).toBe('he said &quot;hello&quot;');
    expect(escapeHtml("it's safe")).toBe('it&#39;s safe');
  });

  it('should return empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('should handle strings with no special characters', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('should handle already-escaped strings by double-escaping', () => {
    // Since escapeHtml uses textContent/innerHTML, &lt; becomes &amp;lt;
    const result = escapeHtml('&lt;');
    expect(result).toBe('&amp;lt;');
  });

  it('should escape tags and angle brackets', () => {
    expect(escapeHtml('<div>')).toBe('&lt;div&gt;');
  });
});

describe('getTimeAgo', () => {
  const now = new Date('2026-04-08T12:58:00Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return "just now" for less than 60 seconds ago', () => {
    const date = new Date('2026-04-08T12:57:30Z');
    expect(getTimeAgo(date)).toBe('just now');
  });

  it('should return "just now" for 0 seconds ago', () => {
    expect(getTimeAgo(now)).toBe('just now');
  });

  it('should return minutes for time between 60 seconds and 1 hour', () => {
    const date = new Date('2026-04-08T12:28:00Z'); // 30 minutes ago
    expect(getTimeAgo(date)).toBe('30 minutes ago');
  });

  it('should return 1 minute ago for exactly 60 seconds', () => {
    const date = new Date('2026-04-08T12:57:00Z');
    expect(getTimeAgo(date)).toBe('1 minutes ago');
  });

  it('should return hours for time between 1 hour and 1 day', () => {
    const date = new Date('2026-04-08T09:58:00Z'); // 3 hours ago
    expect(getTimeAgo(date)).toBe('3 hours ago');
  });

  it('should return 1 hours ago for exactly 3600 seconds', () => {
    const date = new Date('2026-04-08T11:58:00Z');
    expect(getTimeAgo(date)).toBe('1 hours ago');
  });

  it('should return days for time between 1 day and 7 days', () => {
    const date = new Date('2026-04-06T12:58:00Z'); // 2 days ago
    expect(getTimeAgo(date)).toBe('2 days ago');
  });

  it('should return days for exactly 1 day ago', () => {
    const date = new Date('2026-04-07T12:58:00Z');
    expect(getTimeAgo(date)).toBe('1 days ago');
  });

  it('should return formatted date for 7+ days ago', () => {
    const date = new Date('2026-03-25T12:58:00Z'); // 14 days ago
    expect(getTimeAgo(date)).toBe(date.toLocaleDateString());
  });

  it('should return formatted date for months ago', () => {
    const date = new Date('2026-01-08T12:58:00Z'); // 3 months ago
    expect(getTimeAgo(date)).toBe(date.toLocaleDateString());
  });

  it('should return formatted date for over a year ago', () => {
    const date = new Date('2025-04-08T12:58:00Z'); // 1 year ago
    expect(getTimeAgo(date)).toBe(date.toLocaleDateString());
  });

  it('should return "just now" for negative delta (future date)', () => {
    // Negative seconds (future dates) are < 60, so getTimeAgo returns "just now"
    const date = new Date('2026-04-08T13:00:00Z'); // 2 minutes in the future
    const result = getTimeAgo(date);
    expect(result).toBe('just now');
  });
});

describe('renderValue', () => {
  it('should render null as italic null', () => {
    expect(renderValue(null)).toBe('<em style="color: #999;">null</em>');
  });

  it('should render undefined as italic null', () => {
    expect(renderValue(undefined)).toBe('<em style="color: #999;">null</em>');
  });

  it('should render boolean as strong', () => {
    expect(renderValue(true)).toBe('<strong>true</strong>');
    expect(renderValue(false)).toBe('<strong>false</strong>');
  });

  it('should render number as strong', () => {
    expect(renderValue(42)).toBe('<strong>42</strong>');
  });

  it('should render string as paragraph', () => {
    expect(renderValue('hello')).toBe('<p>hello</p>');
  });

  it('should escape HTML in strings', () => {
    const result = renderValue('<script>');
    expect(result).toContain('&lt;script&gt;');
  });

  it('should preserve line breaks in strings', () => {
    expect(renderValue('line1\nline2')).toBe('<p>line1<br>line2</p>');
  });

  it('should render empty array', () => {
    expect(renderValue([])).toBe('<em style="color: #999;">Empty array</em>');
  });

  it('should render array as unordered list', () => {
    const result = renderValue(['a', 'b']);
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>');
    expect(result).toContain('a');
    expect(result).toContain('b');
  });

  it('should render object with sections', () => {
    const result = renderValue({ foo: 'bar' });
    expect(result).toContain('Foo'); // key is capitalized
    expect(result).toContain('bar');
    expect(result).toContain('upwork-buddy-section');
  });
});

describe('renderAnalysis', () => {
  it('should render a basic analysis with all sections', () => {
    const analysis: AnalysisResponse = {
      proposal: 'Here is a cover letter',
      execution_prompt: 'Create a spec sheet',
      time_estimate: '2-3 days',
      workload_division: 'Split the work',
      questions_for_client: 'What is your budget?',
      tips_and_advice: 'Be professional',
      tone_analysis: 'Professional tone',
    };

    const html = renderAnalysis(analysis);

    expect(html).toContain('Proposal');
    expect(html).toContain('Here is a cover letter');
    expect(html).toContain('Execution Prompt');
    expect(html).toContain('Time Estimate');
    expect(html).toContain('Workload Division');
    expect(html).toContain('Questions For Client');
    expect(html).toContain('Tips And Advice');
    expect(html).toContain('Tone Analysis');
  });

  it('should create collapsible sections', () => {
    const analysis: AnalysisResponse = {
      proposal: 'test proposal',
    };

    const html = renderAnalysis(analysis);

    expect(html).toContain('upwork-buddy-section');
    expect(html).toContain('upwork-buddy-section-header');
    expect(html).toContain('upwork-buddy-section-content');
    expect(html).toContain('upwork-buddy-section-toggle');
  });

  it('should have default-open sections for proposal and time_estimate', () => {
    const analysis: AnalysisResponse = {
      proposal: 'test',
      time_estimate: '1 day',
    };

    const html = renderAnalysis(analysis);

    // Check that proposal and time_estimate sections have 'open' class on their content divs
    const openSections = html.match(/upwork-buddy-section-content open/g) || [];
    expect(openSections.length).toBe(2); // proposal + time_estimate

    // Verify the open sections are for proposal and time_estimate by checking
    // that their toggle buttons also have the 'open' class
    const openToggles = html.match(/upwork-buddy-section-toggle open/g) || [];
    expect(openToggles.length).toBe(2);
  });

  it('should show icons for known sections', () => {
    const analysis: AnalysisResponse = {
      proposal: 'test',
    };

    const html = renderAnalysis(analysis);
    expect(html).toContain('📝'); // proposal icon
  });

  it('should show cached indicator when flag is set and analysis is cached', () => {
    const analysis: AnalysisResponse = {
      _cached: true,
      proposal: 'test',
    };

    const html = renderAnalysis(analysis, true);
    expect(html).toContain('Loaded from cache');
  });

  it('should not show cached indicator when flag is false', () => {
    const analysis: AnalysisResponse = {
      _cached: true,
      proposal: 'test',
    };

    const html = renderAnalysis(analysis, false);
    expect(html).not.toContain('Loaded from cache');
  });

  it('should skip internal fields starting with underscore', () => {
    const analysis: AnalysisResponse = {
      _cached: true,
      proposal: 'test',
    };

    const html = renderAnalysis(analysis);
    // _cached should not be rendered as a section
    // Count sections - should only be 1 (proposal)
    const sectionCount = (html.match(/upwork-buddy-section-header/g) || []).length;
    expect(sectionCount).toBe(1);
  });

  it('should handle empty analysis', () => {
    const analysis: AnalysisResponse = {};
    const html = renderAnalysis(analysis);
    expect(html).toBe('');
  });

  it('should handle analysis with non-standard fields', () => {
    const analysis: AnalysisResponse = {
      proposal: 'test',
      custom_field: 'custom value',
    };

    const html = renderAnalysis(analysis);
    expect(html).toContain('Custom Field');
    expect(html).toContain('custom value');
  });

  it('should never emit inline onclick attributes', () => {
    const analysis: AnalysisResponse = {
      proposal: 'test',
      time_estimate: JSON.stringify({ phase_1: '2 hours' }),
    };

    const html = renderAnalysis(analysis);
    expect(html).not.toMatch(/on[a-z]+=/i);
    expect(html).toContain('data-collapsible="true"');
  });
});

describe('sanitizeHttpUrl', () => {
  it('allows valid http and https URLs', () => {
    expect(sanitizeHttpUrl('https://example.com/portfolio')).toBe('https://example.com/portfolio');
    expect(sanitizeHttpUrl(' http://localhost:3000/demo ')).toBe('http://localhost:3000/demo');
  });

  it('rejects javascript:, data:, and malformed URLs', () => {
    expect(sanitizeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(sanitizeHttpUrl('not a valid url')).toBeNull();
    expect(sanitizeHttpUrl('   ')).toBeNull();
  });
});

describe('attachCollapsibleListeners', () => {
  it('toggles flat and nested collapsible sections on click', () => {
    const container = document.createElement('div');
    container.innerHTML = renderAnalysis({
      proposal: 'Cover letter',
      time_estimate: JSON.stringify({ setup: '1 hour' }),
    });

    attachCollapsibleListeners(container);

    const headers = container.querySelectorAll<HTMLElement>(
      '.upwork-buddy-section-header[data-collapsible="true"]',
    );
    expect(headers.length).toBe(3);

    const proposalHeader = headers[0];
    const proposalContent = proposalHeader.nextElementSibling;
    expect(proposalContent?.classList.contains('open')).toBe(true);

    proposalHeader.click();
    expect(proposalContent?.classList.contains('open')).toBe(false);

    const nestedHeader = headers[2];
    const nestedContent = nestedHeader.nextElementSibling;
    expect(nestedContent?.classList.contains('open')).toBe(false);
    nestedHeader.click();
    expect(nestedContent?.classList.contains('open')).toBe(true);
  });
});
