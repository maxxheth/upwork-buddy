/**
 * Extract job information from Upwork job details drawer
 * Uses fallback selector chains for resilience against DOM changes
 */

import type { JobInfo } from './types';

/**
 * Defines a chain of CSS selectors to try in order for a given field.
 * Primary selector first, then increasingly generic fallbacks.
 */
interface SelectorChain {
  field: keyof JobInfo;
  selectors: string[];
  attribute?: string; // e.g., 'href' for links; textContent is default
  transform?: (value: string) => string; // optional post-processing
  isMulti?: boolean; // if true, collect all matches (e.g., skills)
}

/**
 * Selector chains defining primary + fallback selectors for each JobInfo field.
 * Primary selectors mirror the current Upwork DOM; fallbacks cover alternate
 * class names, data-test attributes, and generic patterns.
 */
const SELECTOR_CHAINS: SelectorChain[] = [
  {
    field: 'title',
    selectors: [
      'h2[itemprop="name"]',
      'h2.h4',
      'h3.job-tile-title a',
      '[data-test="job-title-link"]',
      'h2 a',
      '.job-tile-title a',
      '.job-details-card h4 .flex-1',
      '.job-details-card h4 span',
      'h2',
      'h3',
    ],
  },
  {
    field: 'description',
    selectors: [
      '[data-test="Description"]',
      '[data-test="job-description-text"]',
      '[data-test="job-description-line-clamp"] span',
      '.job-description',
      '.description',
      '[data-test="UpCLineClamp"] span',
      '.job-details-content',
      '.air3-section .mb-0',
    ],
  },
  {
    field: 'budget',
    selectors: [
      '[data-test="is-fixed-price"]',
      '[data-test="budget"]',
      '.budget',
      '[data-test="job-type-label"]',
      '.js-budget',
      '.air3-budget',
    ],
  },
  {
    field: 'skills',
    selectors: [
      'a.air3-token',
      '[data-test="token"]',
      '.skill-badge',
      '.o-tag-skill',
      '[data-test="attr-item"]',
      '[data-test="skill"]',
      '.js-skill',
    ],
    isMulti: true,
  },
];

export class JobExtractor {
  /**
   * Extract job information from a container element using fallback selector chains.
   * Returns a JobInfo even if some fields could not be extracted (partial extraction).
   */
  extractJobInfo(container: Element): JobInfo {
    console.log('🔍 Extracting from container:', container.className);

    const result: Partial<JobInfo> = {};
    const fieldStatus: Record<string, 'ok' | 'fallback' | 'broken'> = {};

    for (const chain of SELECTOR_CHAINS) {
      const { value, usedIndex } = this.trySelectorChain(container, chain);

      if (value !== null) {
        result[chain.field] = value;
        fieldStatus[chain.field] = usedIndex === 0 ? 'ok' : 'fallback';
        if (usedIndex > 0) {
          this.logFallback(chain, usedIndex);
        }
      } else {
        // Provide default values for missing fields so we always return a complete JobInfo
        result[chain.field] = this.getDefaultValue(chain.field);
        fieldStatus[chain.field] = 'broken';
        console.warn(
          `⚠️ Selector chain for "${chain.field}" exhausted — all ${chain.selectors.length} selectors failed`
        );
      }
    }

    // Log extraction summary
    const ok = Object.values(fieldStatus).filter((s) => s === 'ok').length;
    const fallback = Object.values(fieldStatus).filter((s) => s === 'fallback').length;
    const broken = Object.values(fieldStatus).filter((s) => s === 'broken').length;
    console.log(
      `📊 Extraction summary: ${ok} ok, ${fallback} fallback, ${broken} broken`
    );

    return result as JobInfo;
  }

  /**
   * Try each selector in a chain until one returns a value.
   * Returns the extracted value and the index of the selector that worked,
   * or { value: null, usedIndex: -1 } if nothing matched.
   */
  trySelectorChain(
    container: Element,
    chain: SelectorChain
  ): { value: string | null; usedIndex: number } {
    if (chain.isMulti) {
      // For multi-match fields (e.g., skills), try each selector and
      // return results from the first selector that finds any matches.
      for (let i = 0; i < chain.selectors.length; i++) {
        const selector = chain.selectors[i];
        try {
          const els = container.querySelectorAll(selector);
          if (els.length > 0) {
            const texts = Array.from(els)
              .map((el) => this.extractValue(el, chain))
              .filter((t) => t.length > 0);
            if (texts.length > 0) {
              const raw = texts.join(', ');
              const value = chain.transform ? chain.transform(raw) : raw;
              console.log(
                `🔍 [${chain.field}] selector "${selector}" matched ${texts.length} items (index ${i})`
              );
              return { value, usedIndex: i };
            }
          }
        } catch (err) {
          console.debug(
            `🔍 [${chain.field}] selector "${selector}" threw:`,
            err
          );
        }
      }
      return { value: null, usedIndex: -1 };
    }

    // Single-match fields
    for (let i = 0; i < chain.selectors.length; i++) {
      const selector = chain.selectors[i];
      try {
        const el = container.querySelector(selector);
        if (el) {
          const raw = this.extractValue(el, chain);
          if (raw.length > 0) {
            const value = chain.transform ? chain.transform(raw) : raw;
            console.log(
              `🔍 [${chain.field}] selector "${selector}" matched (index ${i})`
            );
            return { value, usedIndex: i };
          }
        }
      } catch (err) {
        console.debug(
          `🔍 [${chain.field}] selector "${selector}" threw:`,
          err
        );
      }
    }

    return { value: null, usedIndex: -1 };
  }

  /**
   * Log a warning when a fallback selector was needed.
   * This helps identify when Upwork changes their DOM structure.
   */
  private logFallback(chain: SelectorChain, usedIndex: number): void {
    const primary = chain.selectors[0];
    const fallback = chain.selectors[usedIndex];
    console.warn(
      `⚠️ Selector fallback for ${chain.field}: primary selector "${primary}" failed, using fallback "${fallback}"`
    );
  }

  /**
   * Check the health of all selector chains against the current page DOM.
   * Returns an array of statuses that can be used to warn users about
   * potentially broken extraction.
   */
  healthCheck(): { field: string; status: 'ok' | 'fallback' | 'broken' }[] {
    const container =
      this.findJobDrawer() ?? document.body;

    return SELECTOR_CHAINS.map((chain) => {
      const { usedIndex } = this.trySelectorChain(container, chain);

      let status: 'ok' | 'fallback' | 'broken';
      if (usedIndex === -1) {
        status = 'broken';
      } else if (usedIndex === 0) {
        status = 'ok';
      } else {
        status = 'fallback';
      }

      return { field: chain.field as string, status };
    });
  }

  /**
   * Find job details drawer in DOM
   */
  findJobDrawer(): Element | null {
    return document.querySelector('.job-details-content');
  }

  /**
   * Extract a text value from an element using the chain's attribute/transform settings.
   */
  private extractValue(el: Element, chain: SelectorChain): string {
    const raw = chain.attribute
      ? (el.getAttribute(chain.attribute) ?? '')
      : (el.textContent?.trim() ?? '');
    return raw;
  }

  /**
   * Return a sensible default when a field cannot be extracted.
   */
  private getDefaultValue(field: keyof JobInfo): string {
    switch (field) {
      case 'title':
        return 'Unknown Title';
      case 'description':
        return 'No description available';
      case 'budget':
        return 'Not specified';
      case 'skills':
        return 'Not specified';
      default:
        return '';
    }
  }
}

/**
 * Expose SELECTOR_CHAINS for testing purposes.
 */
export { SELECTOR_CHAINS };