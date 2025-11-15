/**
 * Extract job information from Upwork job details drawer
 */

import type { JobInfo } from './types';

export class JobExtractor {
  /**
   * Extract job information from a container element
   */
  extractJobInfo(container: Element): JobInfo {
    console.log('🔍 Extracting from container:', container.className);

    const titleEl = this.findElement(container, [
      'h2[itemprop="name"]',
      'h2.h4',
      'h3.job-tile-title a',
      '[data-test="job-title-link"]',
      'h2 a',
      '.job-tile-title a',
      'h2',
      'h3'
    ], 'title');

    const descEl = this.findElement(container, [
      '[data-test="Description"]',
      '[data-test="job-description-text"]',
      '[data-test="job-description-line-clamp"] span',
      '.job-description',
      '.description',
      '[data-test="UpCLineClamp"] span'
    ], 'description');

    const budgetEl = this.findElement(container, [
      '[data-test="is-fixed-price"]',
      '[data-test="budget"]',
      '.budget',
      '[data-test="job-type-label"]'
    ], 'budget');

    // Skills are in anchor tags with class air3-token or similar
    const skillsEls = container.querySelectorAll('a.air3-token, [data-test="token"], .skill-badge, .o-tag-skill, [data-test="attr-item"]');
    console.log(`✅ Found ${skillsEls.length} skill elements`);

    return {
      title: titleEl ? titleEl.textContent?.trim() || 'Unknown Title' : 'Unknown Title',
      description: descEl ? descEl.textContent?.trim() || 'No description available' : 'No description available',
      budget: budgetEl ? budgetEl.textContent?.trim() || 'Not specified' : 'Not specified',
      skills: Array.from(skillsEls).map(el => el.textContent?.trim() || '').join(', ') || 'Not specified'
    };
  }

  /**
   * Find element using multiple selectors
   */
  private findElement(container: Element, selectors: string[], type: string): Element | null {
    for (const selector of selectors) {
      const el = container.querySelector(selector);
      if (el && el.textContent?.trim()) {
        console.log(`✅ Found ${type} with selector:`, selector);
        return el;
      }
    }
    return null;
  }

  /**
   * Find job details drawer in DOM
   */
  findJobDrawer(): Element | null {
    return document.querySelector('.job-details-content');
  }
}
