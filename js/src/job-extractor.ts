/**
 * Extract job information from Upwork job details drawer.
 *
 * Supports TWO contract layouts:
 *  ──────────────────────────────────────────────────────────────────
 *  HOURLY contract:
 *    <li>
 *      <div data-cy="clock-hourly">  … icon … </div>
 *      <strong>More than 30 hrs/week</strong>
 *      <div class="description">Hourly</div>
 *    </li>
 *    <li>
 *      <div data-cy="clock-timelog"> … icon … </div>
 *      <div class="d-flex">
 *        <div><p><strong> $25.00 </strong></p></div>
 *        <p class="mx-1x">-</p>
 *        <div><p><strong> $100.00 </strong></p></div>
 *      </div>
 *      <div class="description">Hourly</div>
 *    </li>
 *
 *  FIXED-PRICE contract:
 *    <li>
 *      <div data-cy="fixed-price"> … icon … </div>
 *      <div data-test="BudgetAmount"><p><strong> $1,000.00 </strong></p></div>
 *      <div class="description">Fixed-price</div>
 *    </li>
 *  ──────────────────────────────────────────────────────────────────
 *
 *  Skills use: data-test="Skill" on <span> parents with
 *              <a class="air3-badge air3-badge-highlight badge"> containing
 *              <div class="air3-line-clamp is-clamped">skill name</div>
 *
 *  Title:  <h4><span class="flex-1">Title text</span></h4>
 *  Description: <div data-test="Description" …> or <div data-test="Description Description" …>
 *                <p class="text-body-sm multiline-text">…</p>
 */

import type { ContractType, JobInfo } from './types';

/**
 * Defines a chain of CSS selectors to try in order for a given field.
 * Primary selector first, then increasingly generic fallbacks.
 */
interface SelectorChain {
  field: string;
  selectors: string[];
  attribute?: string; // e.g., 'href' for links; textContent is default
  transform?: (value: string) => string;
  isMulti?: boolean; // if true, collect all matches (e.g., skills)
}

/**
 * Selector chains for each field — ordered from most specific to most generic.
 * Primary selectors match the real Upwork DOM captured in June 2025.
 */
const SELECTOR_CHAINS: SelectorChain[] = [
  {
    field: 'title',
    selectors: [
      // June 2025: <h4><span class="flex-1">Title</span></h4> inside .job-details-card
      '.job-details-card h4 span.flex-1',
      'h4 span.flex-1',
      // Older / alternate patterns
      'h2[itemprop="name"]',
      'h2.h4',
      'h3.job-tile-title a',
      '[data-test="job-title-link"]',
      'h2 a',
      '.job-tile-title a',
      '.job-details-card h4 span',
      'h2',
      'h3',
    ],
  },
  {
    field: 'description',
    selectors: [
      // June 2025: data-test="Description" or "Description Description"
      '[data-test="Description"] p.text-body-sm.multiline-text',
      '[data-test="Description Description"] p.text-body-sm.multiline-text',
      '[data-test="Description"] p.multiline-text',
      '[data-test="Description Description"] p.multiline-text',
      '[data-test="Description"]',
      '[data-test="job-description-text"]',
      '[data-test="job-description-line-clamp"] span',
      '.job-description',
      '.description',
      '[data-test="UpCLineClamp"] span',
      '.job-details-content',
    ],
  },
  {
    // The budget chain now detects the full <li> row for BOTH contract types.
    // We extract contract details ourselves in extractBudgetInfo().
    field: 'budgetRow',
    selectors: [
      // Hourly rate row identified by data-cy="clock-timelog"
      'li:has([data-cy="clock-timelog"])',
      // Fixed-price row identified by data-cy="fixed-price"
      'li:has([data-cy="fixed-price"])',
      // Fallback: BudgetAmount test attribute
      '[data-test="BudgetAmount"]',
      // Older fallbacks
      '[data-test="is-fixed-price"]',
      '[data-test="budget"]',
      '.budget',
      '.js-budget',
    ],
  },
  {
    field: 'skills',
    selectors: [
      // June 2025: data-test="Skill" <span> → <a> → <div class="air3-line-clamp">
      '[data-test="Skill"] a.air3-badge .air3-line-clamp',
      '[data-test="Skill"] .air3-line-clamp',
      '[data-test="Skill"] a',
      '[data-test="Skill"]',
      'a.air3-badge.air3-badge-highlight',
      'a.air3-token',
      '[data-test="token"]',
      '.skill-badge',
      '.o-tag-skill',
      '[data-test="attr-item"]',
      '.js-skill',
    ],
    isMulti: true,
  },
  {
    field: 'experienceLevel',
    selectors: [
      // June 2025: <li> with data-cy="expertise" icon → <strong>Level</strong>
      'li:has([data-cy="expertise"]) strong:first-of-type',
      '[data-cy="expertise"] + strong',
    ],
  },
];

/**
 * Parsed budget info from the DOM.
 */
interface BudgetInfo {
  contractType: ContractType;
  rateRange: string;
  rateMin: string;
  rateMax: string;
  budgetAmount: string;
  budget: string;
}

export class JobExtractor {
  /**
   * Extract job information from a container element.
   * Returns a complete JobInfo with contract-type-aware budget data.
   */
  extractJobInfo(container: Element): JobInfo {
    console.log('🔍 Extracting from container:', container.className);

    const result: Partial<JobInfo> = {};
    const fieldStatus: Record<string, 'ok' | 'fallback' | 'broken'> = {};

    // Extract standard fields via selector chains
    for (const chain of SELECTOR_CHAINS) {
      if (chain.field === 'budgetRow') continue; // handled separately
      const { value, usedIndex } = this.trySelectorChain(container, chain);

      if (value !== null) {
        this.assignChainField(result, chain.field, value);
        fieldStatus[chain.field] = usedIndex === 0 ? 'ok' : 'fallback';
        if (usedIndex > 0) {
          this.logFallback(chain, usedIndex);
        }
      } else if (chain.field === 'experienceLevel') {
        const fallbackExp = this.extractExperienceLevelFallback(container);
        if (fallbackExp !== null) {
          result.experienceLevel = fallbackExp;
          fieldStatus[chain.field] = 'fallback';
        } else {
          result.experienceLevel = '';
          fieldStatus[chain.field] = 'broken';
        }
      } else {
        this.assignChainField(result, chain.field, chain.isMulti ? 'Not specified' : '');
        fieldStatus[chain.field] = 'broken';
      }
    }

    // ── Contract-type-aware budget extraction ─────────────────────────
    const budgetInfo = this.extractBudgetInfo(container);
    result.contractType = budgetInfo.contractType;
    result.rateRange = budgetInfo.rateRange;
    result.rateMin = budgetInfo.rateMin;
    result.rateMax = budgetInfo.rateMax;
    result.budgetAmount = budgetInfo.budgetAmount;
    result.budget = budgetInfo.budget;
    fieldStatus['budget'] = budgetInfo.contractType ? 'ok' : 'broken';

    // ── Fill defaults for any missing fields ──────────────────────────
    if (!result.title) result.title = 'Unknown Title';
    if (!result.description) result.description = 'No description available';
    if (!result.skills) result.skills = 'Not specified';
    if (!result.budget) result.budget = 'Not specified';
    if (!result.experienceLevel) result.experienceLevel = 'Not specified';

    // Log extraction summary
    const ok = Object.values(fieldStatus).filter((s) => s === 'ok').length;
    const fallback = Object.values(fieldStatus).filter((s) => s === 'fallback').length;
    const broken = Object.values(fieldStatus).filter((s) => s === 'broken').length;
    console.log(
      `📊 Extraction summary: ${ok} ok, ${fallback} fallback, ${broken} broken — contract=${result.contractType || 'unknown'}`,
    );

    return result as JobInfo;
  }

  /**
   * Extract budget information by detecting whether the job is
   * hourly (rate range) or fixed-price (single amount).
   */
  private extractBudgetInfo(container: Element): BudgetInfo {
    const empty: BudgetInfo = {
      contractType: '',
      rateRange: '',
      rateMin: '',
      rateMax: '',
      budgetAmount: '',
      budget: 'Not specified',
    };

    // ── Strategy 1: Look for the hourly rate row (data-cy="clock-timelog") ──
    const hourlyIcon = container.querySelector('[data-cy="clock-timelog"]');
    if (hourlyIcon) {
      const li = hourlyIcon.closest('li');
      if (li) {
        // The two <strong> elements contain min and max rates
        const strongs = li.querySelectorAll('strong');
        const prices: string[] = [];
        strongs.forEach((s) => {
          const t = s.textContent?.trim() ?? '';
          if (/[$€£]/.test(t) || /^\d+[\d,.]*$/.test(t)) {
            prices.push(t);
          }
        });

        if (prices.length >= 2) {
          return {
            contractType: 'hourly',
            rateRange: `${prices[0]} - ${prices[1]}`,
            rateMin: prices[0],
            rateMax: prices[1],
            budgetAmount: '',
            budget: `${prices[0]} - ${prices[1]}/hr`,
          };
        } else if (prices.length === 1) {
          return {
            contractType: 'hourly',
            rateRange: prices[0],
            rateMin: prices[0],
            rateMax: prices[0],
            budgetAmount: '',
            budget: `${prices[0]}/hr`,
          };
        }
      }
    }

    // ── Strategy 2: Look for fixed-price row (data-cy="fixed-price") ──
    const fixedIcon = container.querySelector('[data-cy="fixed-price"]');
    if (fixedIcon) {
      const li = fixedIcon.closest('li');
      if (li) {
        // BudgetAmount data-test or a strong with a dollar amount
        const budgetEl =
          li.querySelector('[data-test="BudgetAmount"] strong') ?? li.querySelector('strong');
        const amount = budgetEl?.textContent?.trim() ?? '';
        if (amount) {
          return {
            contractType: 'fixed',
            rateRange: '',
            rateMin: '',
            rateMax: '',
            budgetAmount: amount,
            budget: `${amount} fixed`,
          };
        }
      }
    }

    // ── Strategy 3: Fallback — BudgetAmount test attribute ──
    const budgetAmount = container.querySelector('[data-test="BudgetAmount"] strong');
    if (budgetAmount) {
      const amount = budgetAmount.textContent?.trim() ?? '';
      if (amount) {
        // Check if parent has "Fixed-price" or "Hourly" description text
        const parentLi = budgetAmount.closest('li');
        const descEl = parentLi?.querySelector('.description');
        const descText = descEl?.textContent?.trim()?.toLowerCase() ?? '';

        if (descText.includes('hourly')) {
          return {
            contractType: 'hourly',
            rateRange: amount,
            rateMin: amount,
            rateMax: amount,
            budgetAmount: '',
            budget: `${amount}/hr`,
          };
        }
        return {
          contractType: 'fixed',
          rateRange: '',
          rateMin: '',
          rateMax: '',
          budgetAmount: amount,
          budget: `${amount} fixed`,
        };
      }
    }

    // ── Strategy 4: Fallback selector chains for budget ──
    const budgetChain = SELECTOR_CHAINS.find((c) => c.field === 'budgetRow');
    if (budgetChain) {
      // Skip the :has() selectors in jsdom/test env — they may not be supported
      const fallbackSelectors = budgetChain.selectors.filter((s) => !s.startsWith('li:has('));
      for (const sel of fallbackSelectors) {
        try {
          const el = container.querySelector(sel);
          if (el) {
            const text = el.textContent?.trim() ?? '';
            if (text) {
              const isHourly = text.toLowerCase().includes('hourly');
              return {
                contractType: isHourly ? 'hourly' : 'fixed',
                rateRange: isHourly ? text : '',
                rateMin: '',
                rateMax: '',
                budgetAmount: isHourly ? '' : text,
                budget: text,
              };
            }
          }
        } catch {
          // selector not supported
        }
      }
    }

    return empty;
  }

  /**
   * Try each selector in a chain until one returns a value.
   */
  trySelectorChain(
    container: Element,
    chain: SelectorChain,
  ): { value: string | null; usedIndex: number } {
    if (chain.isMulti) {
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
                `🔍 [${chain.field}] selector "${selector}" matched ${texts.length} items (index ${i})`,
              );
              return { value, usedIndex: i };
            }
          }
        } catch (err) {
          console.debug(`🔍 [${chain.field}] selector "${selector}" threw:`, err);
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
            console.log(`🔍 [${chain.field}] selector "${selector}" matched (index ${i})`);
            return { value, usedIndex: i };
          }
        }
      } catch (err) {
        console.debug(`🔍 [${chain.field}] selector "${selector}" threw:`, err);
      }
    }

    return { value: null, usedIndex: -1 };
  }

  /**
   * Log a warning when a fallback selector was needed.
   */
  private logFallback(chain: SelectorChain, usedIndex: number): void {
    const primary = chain.selectors[0];
    const fallback = chain.selectors[usedIndex];
    console.warn(
      `⚠️ Selector fallback for ${chain.field}: primary selector "${primary}" failed, using fallback "${fallback}"`,
    );
  }

  /**
   * Assign an extracted selector value to a known JobInfo field without `any`.
   */
  private assignChainField(target: Partial<JobInfo>, field: string, value: string): void {
    switch (field) {
      case 'title':
        target.title = value;
        break;
      case 'description':
        target.description = value;
        break;
      case 'skills':
        target.skills = value;
        break;
      case 'experienceLevel':
        target.experienceLevel = value;
        break;
      default:
        break;
    }
  }

  /**
   * Fallback DOM scan for experience level without non-standard :contains() CSS selectors.
   */
  private extractExperienceLevelFallback(container: Element): string | null {
    const levels = ['Expert', 'Intermediate', 'Entry'] as const;
    const strongs = container.querySelectorAll('strong');
    for (const el of strongs) {
      const text = el.textContent?.trim() ?? '';
      const lower = text.toLowerCase();
      for (const level of levels) {
        if (text === level || lower.includes(level.toLowerCase())) {
          return level;
        }
      }
    }
    return null;
  }

  /**
   * Check the health of all selector chains against the current page DOM.
   */
  healthCheck(
    targetContainer?: Element,
  ): { field: string; status: 'ok' | 'fallback' | 'broken' }[] {
    const container = targetContainer ?? this.findJobDrawer() ?? document.body;

    return SELECTOR_CHAINS.map((chain) => {
      const { usedIndex } = this.trySelectorChain(container, chain);

      let status: 'ok' | 'fallback' | 'broken';
      if (usedIndex === -1) {
        if (
          chain.field === 'experienceLevel' &&
          this.extractExperienceLevelFallback(container) !== null
        ) {
          status = 'fallback';
        } else {
          status = 'broken';
        }
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
   * Extract a text value from an element.
   */
  private extractValue(el: Element, chain: SelectorChain): string {
    const raw = chain.attribute
      ? (el.getAttribute(chain.attribute) ?? '')
      : (el.textContent?.trim() ?? '');
    return raw;
  }
}

/**
 * Expose SELECTOR_CHAINS for testing purposes.
 */
export { SELECTOR_CHAINS };
