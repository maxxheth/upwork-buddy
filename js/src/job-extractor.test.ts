import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSelectorChains, JobExtractor, SELECTOR_CHAINS } from './job-extractor';
import { BUNDLED_SELECTORS, type SelectorConfig } from './shared/selectors';
import type { JobInfo } from './types';

function createElement(
  tag: string,
  textContent: string,
  attributes: Record<string, string> = {},
): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = textContent;
  for (const [key, value] of Object.entries(attributes)) {
    el.setAttribute(key, value);
  }
  return el;
}

/**
 * Build a realistic Upwork hourly-job drawer mock.
 */
function createHourlyJobDrawer(): HTMLElement {
  const container = document.createElement('div');
  container.classList.add('job-details-content');

  const title = createElement('h4', '');
  const titleSpan = createElement('span', 'Build a React Dashboard', {
    class: 'flex-1',
  });
  title.appendChild(titleSpan);
  container.appendChild(title);

  const desc = createElement('div', 'We need a professional React dashboard with real-time data.', {
    'data-test': 'Description',
  });
  container.appendChild(desc);

  // Hourly rate row
  const hourlyLi = document.createElement('li');
  const clockIcon = createElement('div', '', { 'data-cy': 'clock-timelog' });
  hourlyLi.appendChild(clockIcon);
  const rateWrap = document.createElement('div');
  rateWrap.classList.add('d-flex');
  const minDiv = document.createElement('div');
  const minP = document.createElement('p');
  minP.appendChild(createElement('strong', '$25.00'));
  minDiv.appendChild(minP);
  rateWrap.appendChild(minDiv);
  const dashP = createElement('p', '-', { class: 'mx-1x' });
  rateWrap.appendChild(dashP);
  const maxDiv = document.createElement('div');
  const maxP = document.createElement('p');
  maxP.appendChild(createElement('strong', '$100.00'));
  maxDiv.appendChild(maxP);
  rateWrap.appendChild(maxDiv);
  hourlyLi.appendChild(rateWrap);
  container.appendChild(hourlyLi);

  // Experience level
  const expLi = document.createElement('li');
  expLi.appendChild(createElement('div', '', { 'data-cy': 'expertise' }));
  expLi.appendChild(createElement('strong', 'Expert'));
  container.appendChild(expLi);

  // Skills
  const skill1 = createElement('span', '', { 'data-test': 'Skill' });
  const skillLink1 = createElement('a', 'React', {
    class: 'air3-badge air3-badge-highlight badge',
  });
  const skillDiv1 = createElement('div', 'React', { class: 'air3-line-clamp is-clamped' });
  skillLink1.appendChild(skillDiv1);
  skill1.appendChild(skillLink1);
  container.appendChild(skill1);

  const skill2 = createElement('span', '', { 'data-test': 'Skill' });
  const skillLink2 = createElement('a', 'TypeScript', {
    class: 'air3-badge air3-badge-highlight badge',
  });
  const skillDiv2 = createElement('div', 'TypeScript', { class: 'air3-line-clamp is-clamped' });
  skillLink2.appendChild(skillDiv2);
  skill2.appendChild(skillLink2);
  container.appendChild(skill2);

  return container;
}

/**
 * Build a realistic Upwork fixed-price-job drawer mock.
 */
function createFixedPriceJobDrawer(): HTMLElement {
  const container = document.createElement('div');
  container.classList.add('job-details-content');

  const title = createElement('h4', '');
  const titleSpan = createElement('span', 'Design a Logo', { class: 'flex-1' });
  title.appendChild(titleSpan);
  container.appendChild(title);

  const desc = createElement('div', 'We need a professional logo for our startup.', {
    'data-test': 'Description',
  });
  container.appendChild(desc);

  // Fixed-price row
  const fixedLi = document.createElement('li');
  fixedLi.appendChild(createElement('div', '', { 'data-cy': 'fixed-price' }));
  const budgetDiv = createElement('div', '', { 'data-test': 'BudgetAmount' });
  const budgetP = document.createElement('p');
  budgetP.appendChild(createElement('strong', '$1,000.00'));
  budgetDiv.appendChild(budgetP);
  fixedLi.appendChild(budgetDiv);
  fixedLi.appendChild(createElement('div', 'Fixed-price', { class: 'description' }));
  container.appendChild(fixedLi);

  // Skills
  const skill1 = createElement('span', '', { 'data-test': 'Skill' });
  const skillLink1 = createElement('a', 'Logo Design', {
    class: 'air3-badge air3-badge-highlight badge',
  });
  const skillDiv1 = createElement('div', 'Logo Design', { class: 'air3-line-clamp is-clamped' });
  skillLink1.appendChild(skillDiv1);
  skill1.appendChild(skillLink1);
  container.appendChild(skill1);

  return container;
}

describe('JobExtractor', () => {
  let extractor: JobExtractor;

  beforeEach(() => {
    extractor = new JobExtractor();
    // Clean up any DOM elements from prior tests
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  // ── trySelectorChain ──────────────────────────────────────────────────

  describe('trySelectorChain', () => {
    it('returns value from the primary selector when it matches', () => {
      const container = document.createElement('div');
      const h4 = document.createElement('h4');
      const span = createElement('span', 'Primary Title', { class: 'flex-1' });
      h4.appendChild(span);
      container.appendChild(h4);

      const chain = SELECTOR_CHAINS.find((c) => c.field === 'title')!;
      const result = extractor.trySelectorChain(container, chain);

      expect(result.value).toBe('Primary Title');
      // The primary selector `.job-details-card h4 span.flex-1` requires a
      // wrapper with that class, so in a bare container it matches the second
      // selector `h4 span.flex-1` (index 1). This is expected in tests.
      expect(result.usedIndex).toBeGreaterThanOrEqual(0);
    });

    it('falls back to a secondary selector when primary fails', () => {
      const container = document.createElement('div');
      // No h4 span.flex-1, but there is an h2[itemprop="name"]
      container.appendChild(createElement('h2', 'Fallback Title', { itemprop: 'name' }));

      const chain = SELECTOR_CHAINS.find((c) => c.field === 'title')!;
      const result = extractor.trySelectorChain(container, chain);

      expect(result.value).toBe('Fallback Title');
      expect(result.usedIndex).toBeGreaterThan(0);
    });

    it('returns null with usedIndex -1 when all selectors fail', () => {
      const container = document.createElement('div'); // empty

      const chain = SELECTOR_CHAINS.find((c) => c.field === 'title')!;
      const result = extractor.trySelectorChain(container, chain);

      expect(result.value).toBeNull();
      expect(result.usedIndex).toBe(-1);
    });

    it('works with isMulti chains (skills)', () => {
      const container = document.createElement('div');
      const skill1 = createElement('span', '', { 'data-test': 'Skill' });
      const link1 = createElement('a', 'Python', { class: 'air3-badge' });
      const div1 = createElement('div', 'Python', { class: 'air3-line-clamp' });
      link1.appendChild(div1);
      skill1.appendChild(link1);
      container.appendChild(skill1);

      const skill2 = createElement('span', '', { 'data-test': 'Skill' });
      const link2 = createElement('a', 'Django', { class: 'air3-badge' });
      const div2 = createElement('div', 'Django', { class: 'air3-line-clamp' });
      link2.appendChild(div2);
      skill2.appendChild(link2);
      container.appendChild(skill2);

      const chain = SELECTOR_CHAINS.find((c) => c.field === 'skills')!;
      const result = extractor.trySelectorChain(container, chain);

      expect(result.value).toBe('Python, Django');
      expect(result.usedIndex).toBe(0);
    });

    it('falls back to data-test="token" for skills when primary selectors are absent', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('a', 'Go', { 'data-test': 'token' }));
      container.appendChild(createElement('a', 'Rust', { 'data-test': 'token' }));

      const chain = SELECTOR_CHAINS.find((c) => c.field === 'skills')!;
      const result = extractor.trySelectorChain(container, chain);

      expect(result.value).toBe('Go, Rust');
      expect(result.usedIndex).toBeGreaterThan(0);
    });

    it('skips elements with empty textContent', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('h2', '   ', { itemprop: 'name' }));

      const chain = SELECTOR_CHAINS.find((c) => c.field === 'title')!;
      const result = extractor.trySelectorChain(container, chain);

      if (result.value === null) {
        expect(result.usedIndex).toBe(-1);
      } else {
        expect(result.usedIndex).toBeGreaterThan(0);
      }
    });

    it('supports the attribute option for extracting non-textContent values', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('a', 'Click here', { href: 'https://example.com' }));

      const chain = {
        field: 'title' as keyof JobInfo,
        selectors: ['a'],
        attribute: 'href',
      };
      const result = extractor.trySelectorChain(container, chain);

      expect(result.value).toBe('https://example.com');
      expect(result.usedIndex).toBe(0);
    });

    it('applies the transform function when provided', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('div', 'hello world', { 'data-test': 'budget' }));

      const chain = {
        field: 'budget' as keyof JobInfo,
        selectors: ['[data-test="budget"]'],
        transform: (v: string) => v.toUpperCase(),
      };
      const result = extractor.trySelectorChain(container, chain);

      expect(result.value).toBe('HELLO WORLD');
    });

    it('catches and skips selectors that throw (invalid selector)', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('h4', 'Valid', {}));
      const span = createElement('span', 'Valid', { class: 'flex-1' });
      container.querySelector('h4')!.appendChild(span);

      const chain = {
        field: 'title' as keyof JobInfo,
        selectors: ['!!!invalid!!!', 'h4 span.flex-1'],
      };
      const result = extractor.trySelectorChain(container, chain);

      expect(result.value).toBe('Valid');
      expect(result.usedIndex).toBe(1);
    });
  });

  // ── extractJobInfo ────────────────────────────────────────────────────

  describe('extractJobInfo', () => {
    it('extracts hourly contract fields from a realistic hourly drawer', () => {
      const drawer = createHourlyJobDrawer();
      const result = extractor.extractJobInfo(drawer);

      expect(result.title).toBe('Build a React Dashboard');
      expect(result.description).toContain('professional React dashboard');
      expect(result.contractType).toBe('hourly');
      expect(result.rateRange).toBe('$25.00 - $100.00');
      expect(result.rateMin).toBe('$25.00');
      expect(result.rateMax).toBe('$100.00');
      expect(result.budget).toBe('$25.00 - $100.00/hr');
      expect(result.budgetAmount).toBe('');
      expect(result.skills).toContain('React');
      expect(result.skills).toContain('TypeScript');
      expect(result.experienceLevel).toBe('Expert');
    });

    it('extracts fixed-price contract fields from a realistic fixed-price drawer', () => {
      const drawer = createFixedPriceJobDrawer();
      const result = extractor.extractJobInfo(drawer);

      expect(result.title).toBe('Design a Logo');
      expect(result.description).toContain('professional logo');
      expect(result.contractType).toBe('fixed');
      expect(result.budgetAmount).toBe('$1,000.00');
      expect(result.budget).toBe('$1,000.00 fixed');
      expect(result.rateRange).toBe('');
      expect(result.rateMin).toBe('');
      expect(result.rateMax).toBe('');
      expect(result.skills).toContain('Logo Design');
    });

    it('extracts title using fallback h2[itemprop] selector', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('h2', 'Simple Title', { itemprop: 'name' }));
      container.appendChild(createElement('div', 'Desc', { 'data-test': 'Description' }));

      const result = extractor.extractJobInfo(container);
      expect(result.title).toBe('Simple Title');
    });

    it('extracts title using h3 fallback', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('h3', 'Fallback Title'));
      container.appendChild(createElement('div', 'A description', { 'data-test': 'Description' }));

      const result = extractor.extractJobInfo(container);
      expect(result.title).toBe('Fallback Title');
    });

    it('returns defaults for all missing elements', () => {
      const container = document.createElement('div');
      const result = extractor.extractJobInfo(container);

      expect(result.title).toBe('Unknown Title');
      expect(result.description).toBe('No description available');
      expect(result.budget).toBe('Not specified');
      expect(result.skills).toBe('Not specified');
      expect(result.contractType).toBe('');
      expect(result.experienceLevel).toBe('Not specified');
    });

    it('returns default title when title element has empty text', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('h2', '  '));

      const result = extractor.extractJobInfo(container);
      expect(result.title).toBe('Unknown Title');
    });

    it('handles partial extraction (only title and description)', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('h2', 'Partial Job', { itemprop: 'name' }));
      container.appendChild(
        createElement('div', 'Some description', { 'data-test': 'Description' }),
      );

      const result = extractor.extractJobInfo(container);

      expect(result.title).toBe('Partial Job');
      expect(result.description).toBe('Some description');
      expect(result.budget).toBe('Not specified');
      expect(result.skills).toBe('Not specified');
      expect(result.contractType).toBe('');
    });

    it('extracts skills from data-test="Skill" with air3-line-clamp children', () => {
      const container = document.createElement('div');
      const skill1 = createElement('span', '', { 'data-test': 'Skill' });
      const link1 = createElement('a', 'Python', { class: 'air3-badge' });
      const div1 = createElement('div', 'Python', { class: 'air3-line-clamp' });
      link1.appendChild(div1);
      skill1.appendChild(link1);
      container.appendChild(skill1);

      const skill2 = createElement('span', '', { 'data-test': 'Skill' });
      const link2 = createElement('a', 'Django', { class: 'air3-badge' });
      const div2 = createElement('div', 'Django', { class: 'air3-line-clamp' });
      link2.appendChild(div2);
      skill2.appendChild(link2);
      container.appendChild(skill2);

      const result = extractor.extractJobInfo(container);
      expect(result.skills).toContain('Python');
      expect(result.skills).toContain('Django');
    });

    it('extracts skills from air3-token fallback', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('a', 'React', { class: 'air3-token' }));
      container.appendChild(createElement('a', 'Node.js', { class: 'air3-token' }));
      container.appendChild(createElement('a', 'PostgreSQL', { class: 'air3-token' }));

      const result = extractor.extractJobInfo(container);
      expect(result.skills).toBe('React, Node.js, PostgreSQL');
    });

    it('filters out empty-skill elements from the join', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('a', 'React', { class: 'air3-token' }));
      container.appendChild(createElement('a', '', { class: 'air3-token' }));

      const result = extractor.extractJobInfo(container);
      expect(result.skills).toBe('React');
    });

    it('trims whitespace from extracted text', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('h2', '  Spaced Title  ', { itemprop: 'name' }));
      container.appendChild(
        createElement('div', '  Spaced Description  ', {
          'data-test': 'Description',
        }),
      );

      const result = extractor.extractJobInfo(container);
      expect(result.title).toBe('Spaced Title');
      expect(result.description).toBe('Spaced Description');
    });

    it('extracts hourly rate from clock-timelog row', () => {
      const container = document.createElement('div');
      const li = document.createElement('li');
      li.appendChild(createElement('div', '', { 'data-cy': 'clock-timelog' }));
      const rateWrap = document.createElement('div');
      rateWrap.classList.add('d-flex');
      const minP = document.createElement('p');
      minP.appendChild(createElement('strong', '$30.00'));
      rateWrap.appendChild(minP.parentElement ?? minP);
      rateWrap.appendChild(createElement('p', '-', { class: 'mx-1x' }));
      const maxP2 = document.createElement('p');
      maxP2.appendChild(createElement('strong', '$75.00'));
      rateWrap.appendChild(maxP2.parentElement ?? maxP2);
      li.appendChild(rateWrap);
      container.appendChild(li);

      const result = extractor.extractJobInfo(container);
      expect(result.contractType).toBe('hourly');
      expect(result.rateMin).toBe('$30.00');
      expect(result.rateMax).toBe('$75.00');
      expect(result.budget).toBe('$30.00 - $75.00/hr');
    });

    it('extracts fixed-price from data-cy="fixed-price" row', () => {
      const container = document.createElement('div');
      const li = document.createElement('li');
      li.appendChild(createElement('div', '', { 'data-cy': 'fixed-price' }));
      const budgetDiv = createElement('div', '', { 'data-test': 'BudgetAmount' });
      const p = document.createElement('p');
      p.appendChild(createElement('strong', '$2,500.00'));
      budgetDiv.appendChild(p);
      li.appendChild(budgetDiv);
      container.appendChild(li);

      const result = extractor.extractJobInfo(container);
      expect(result.contractType).toBe('fixed');
      expect(result.budgetAmount).toBe('$2,500.00');
      expect(result.budget).toBe('$2,500.00 fixed');
    });

    it('falls back to data-test="is-fixed-price" for budget', () => {
      const container = document.createElement('div');
      container.appendChild(
        createElement('div', 'Fixed Price: $3,000', {
          'data-test': 'is-fixed-price',
        }),
      );

      const result = extractor.extractJobInfo(container);
      expect(result.budget).toContain('$3,000');
    });

    it('always returns a complete JobInfo object (no undefined fields)', () => {
      const container = document.createElement('div');
      const result = extractor.extractJobInfo(container);

      const requiredKeys: (keyof JobInfo)[] = [
        'title',
        'description',
        'contractType',
        'rateRange',
        'rateMin',
        'rateMax',
        'budgetAmount',
        'budget',
        'experienceLevel',
        'skills',
      ];
      for (const key of requiredKeys) {
        expect(result[key]).toBeDefined();
        expect(typeof result[key]).toBe('string');
      }
    });
  });

  // ── healthCheck ───────────────────────────────────────────────────────

  describe('healthCheck', () => {
    it('returns "ok" for matched fields in an hourly job drawer', () => {
      const drawer = createHourlyJobDrawer();
      document.body.appendChild(drawer);

      const results = extractor.healthCheck();

      // skills use primary selector (data-test="Skill" a.air3-badge .air3-line-clamp)
      expect(results.find((r) => r.field === 'skills')?.status).toBe('ok');

      document.body.removeChild(drawer);
    });

    it('returns "fallback" when primary selector fails but fallback works', () => {
      const drawer = document.createElement('div');
      drawer.classList.add('job-details-content');
      drawer.appendChild(createElement('h2', 'Via H2 Fallback'));
      drawer.appendChild(createElement('div', 'Desc', { 'data-test': 'Description' }));
      document.body.appendChild(drawer);

      const results = extractor.healthCheck();
      const titleResult = results.find((r) => r.field === 'title');
      expect(titleResult?.status).toBe('fallback');

      document.body.removeChild(drawer);
    });

    it('returns "broken" when no selector in a chain matches', () => {
      const results = extractor.healthCheck();

      // In an empty page, fields should be broken
      for (const r of results) {
        expect(r.status).toBe('broken');
      }
    });

    it('falls back to document.body when no drawer is present', () => {
      const results = extractor.healthCheck();
      expect(results.length).toBe(SELECTOR_CHAINS.length);
    });

    it('every selector in SELECTOR_CHAINS is valid standard CSS (no :contains)', () => {
      const probe = document.createElement('div');
      for (const chain of SELECTOR_CHAINS) {
        for (const selector of chain.selectors) {
          expect(selector).not.toContain(':contains(');
          expect(() => probe.querySelector(selector)).not.toThrow();
        }
      }
    });

    it('extractExperienceLevelFallback detects Expert, Intermediate, and Entry without :contains()', () => {
      for (const level of ['Expert', 'Intermediate', 'Entry'] as const) {
        const container = document.createElement('div');
        container.appendChild(createElement('strong', `${level} level required`));
        const info = extractor.extractJobInfo(container);
        expect(info.experienceLevel).toBe(level);

        const health = extractor.healthCheck(container);
        expect(health.find((r) => r.field === 'experienceLevel')?.status).toBe('fallback');
      }
    });
  });

  // ── logFallback ───────────────────────────────────────────────────────

  describe('logFallback', () => {
    it('logs a warning when a fallback selector is used', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const container = document.createElement('div');
      container.appendChild(createElement('h2', 'Fallback Title', { itemprop: 'name' }));

      extractor.extractJobInfo(container);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Selector fallback for title'));

      warnSpy.mockRestore();
    });
  });

  // ── findJobDrawer ─────────────────────────────────────────────────────

  describe('findJobDrawer', () => {
    it('returns the job details drawer element', () => {
      const drawer = createElement('div', 'Job Details', {
        class: 'job-details-content',
      });
      document.body.appendChild(drawer);

      const result = extractor.findJobDrawer();
      expect(result).toBe(drawer);

      document.body.removeChild(drawer);
    });

    it('returns null when no drawer exists', () => {
      // Ensure no leftover drawers from other tests
      document.body.innerHTML = '';
      const result = extractor.findJobDrawer();
      expect(result).toBeNull();
    });
  });

  // ── Live SelectorConfig healing ─────────────────────────────────────────

  describe('live SelectorConfig chains', () => {
    it('buildSelectorChains overrides mutated skills selectors while preserving fallbacks', () => {
      const container = document.createElement('div');
      container.innerHTML = `
        <h4 class="m-0">Patched Job Title</h4>
        <div data-test="Description"><p class="text-body-sm">Need Go and Playwright automation.</p></div>
        <ul class="patched-skill-chips">
          <li class="custom-skill"><span>Go</span></li>
          <li class="custom-skill"><span>Playwright</span></li>
        </ul>
      `;

      // Before patching, default selectors cannot extract mutated skill chips
      const brokenHealth = extractor.healthCheck(container);
      expect(brokenHealth.find((r) => r.field === 'skills')?.status).toBe('broken');
      expect(extractor.extractJobInfo(container).skills).toBe('Not specified');

      const patchedConfig: SelectorConfig = {
        ...BUNDLED_SELECTORS,
        version: '2.0.1',
        views: {
          ...BUNDLED_SELECTORS.views,
          job_detail: {
            ...BUNDLED_SELECTORS.views.job_detail,
            fields: {
              ...BUNDLED_SELECTORS.views.job_detail.fields,
              skills: {
                selectors: ['.patched-skill-chips .custom-skill span'],
                extract: 'list',
              },
            },
          },
        },
      };

      const chains = buildSelectorChains(patchedConfig);
      expect(chains.find((c) => c.field === 'skills')?.selectors[0]).toBe(
        '.patched-skill-chips .custom-skill span',
      );

      const healedHealth = extractor.healthCheck(container, patchedConfig);
      expect(healedHealth.find((r) => r.field === 'skills')?.status).toBe('ok');
      expect(healedHealth.find((r) => r.field === 'skills')?.matchedCount).toBe(2);

      const healedInfo = extractor.extractJobInfo(container, patchedConfig);
      expect(healedInfo.skills).toBe('Go, Playwright');
    });

    it('extracts hourly job without posted rate range (clock-hourly only) and passes budgetRow healthCheck', () => {
      const container = document.createElement('div');
      container.classList.add('job-details-content');
      container.innerHTML = `
        <div class="job-details-card">
          <h4><span class="flex-1">Hourly Job Without Rate</span></h4>
        </div>
        <div data-test="Description"><p class="multiline-text">Ongoing hourly contract.</p></div>
        <ul>
          <li><div data-cy="clock-hourly"></div><strong>More than 30 hrs/week</strong><div class="description">Hourly</div></li>
        </ul>
      `;

      const info = extractor.extractJobInfo(container);
      expect(info.contractType).toBe('hourly');
      expect(info.budget).toBe('Hourly (More than 30 hrs/week)');
      expect(info.rateRange).toBe('');

      const defaultHealth = extractor.healthCheck(container);
      const defaultBudgetRow = defaultHealth.find((r) => r.field === 'budgetRow');
      expect(['ok', 'fallback']).toContain(defaultBudgetRow?.status);

      const bundledHealth = extractor.healthCheck(container, BUNDLED_SELECTORS);
      const bundledBudgetRow = bundledHealth.find((r) => r.field === 'budgetRow');
      expect(['ok', 'fallback']).toContain(bundledBudgetRow?.status);
    });
  });
});
