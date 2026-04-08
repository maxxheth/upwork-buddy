import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobExtractor, SELECTOR_CHAINS } from './job-extractor';
import type { JobInfo } from './types';

function createElement(
  tag: string,
  textContent: string,
  attributes: Record<string, string> = {}
): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = textContent;
  for (const [key, value] of Object.entries(attributes)) {
    el.setAttribute(key, value);
  }
  return el;
}

/**
 * Build a realistic Upwork job drawer mock with all fields.
 */
function createFullJobDrawer(): HTMLElement {
  const container = document.createElement('div');

  const title = createElement('h2', 'Build a React E-Commerce Website', {
    itemprop: 'name',
  });
  container.appendChild(title);

  const desc = createElement(
    'div',
    'We need a professional e-commerce website built with React and TypeScript. The site should include a product catalog, shopping cart, and checkout flow.',
    { 'data-test': 'Description' }
  );
  container.appendChild(desc);

  const budget = createElement('div', '$5,000', {
    'data-test': 'is-fixed-price',
  });
  container.appendChild(budget);

  const skill1 = createElement('a', 'React', { class: 'air3-token' });
  const skill2 = createElement('a', 'TypeScript', { class: 'air3-token' });
  container.appendChild(skill1);
  container.appendChild(skill2);

  return container;
}

describe('JobExtractor', () => {
  let extractor: JobExtractor;

  beforeEach(() => {
    extractor = new JobExtractor();
  });

  // ── trySelectorChain ──────────────────────────────────────────────────

  describe('trySelectorChain', () => {
    it('returns value from the primary selector when it matches', () => {
      const container = document.createElement('div');
      container.appendChild(
        createElement('h2', 'Primary Title', { itemprop: 'name' })
      );

      const chain = SELECTOR_CHAINS.find((c) => c.field === 'title')!;
      const result = extractor.trySelectorChain(container, chain);

      expect(result.value).toBe('Primary Title');
      expect(result.usedIndex).toBe(0);
    });

    it('falls back to a secondary selector when primary fails', () => {
      const container = document.createElement('div');
      // No h2[itemprop="name"], but there is an h2 a
      const link = createElement('a', 'Fallback Title');
      const heading = createElement('h2', '');
      heading.appendChild(link);
      container.appendChild(heading);

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
      container.appendChild(createElement('a', 'Python', { class: 'air3-token' }));
      container.appendChild(createElement('a', 'Django', { class: 'air3-token' }));

      const chain = SELECTOR_CHAINS.find((c) => c.field === 'skills')!;
      const result = extractor.trySelectorChain(container, chain);

      expect(result.value).toBe('Python, Django');
      expect(result.usedIndex).toBe(0);
    });

    it('falls back to data-test="token" for skills when air3-token is absent', () => {
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
      const h2 = createElement('h2', '   ', { itemprop: 'name' });
      container.appendChild(h2);

      const chain = SELECTOR_CHAINS.find((c) => c.field === 'title')!;
      const result = extractor.trySelectorChain(container, chain);

      // The primary selector finds the element but text is whitespace-only,
      // so it should fall through to the next selector that has real content or null
      if (result.value === null) {
        expect(result.usedIndex).toBe(-1);
      } else {
        // Could match a later selector if something else was added
        expect(result.usedIndex).toBeGreaterThan(0);
      }
    });

    it('supports the attribute option for extracting non-textContent values', () => {
      const container = document.createElement('div');
      const link = createElement('a', 'Click here', { href: 'https://example.com' });
      container.appendChild(link);

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
      container.appendChild(
        createElement('div', 'hello world', { 'data-test': 'budget' })
      );

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
      container.appendChild(createElement('h2', 'Valid', { itemprop: 'name' }));

      const chain = {
        field: 'title' as keyof JobInfo,
        // An invalid selector followed by a valid one
        selectors: ['!!!invalid!!!', 'h2[itemprop="name"]'],
      };
      const result = extractor.trySelectorChain(container, chain);

      // Should skip the invalid one and find the valid one
      expect(result.value).toBe('Valid');
      expect(result.usedIndex).toBe(1);
    });
  });

  // ── extractJobInfo ────────────────────────────────────────────────────

  describe('extractJobInfo', () => {
    it('extracts all fields from a realistic Upwork job drawer', () => {
      const container = createFullJobDrawer();
      const result = extractor.extractJobInfo(container);

      expect(result.title).toBe('Build a React E-Commerce Website');
      expect(result.description).toContain('professional e-commerce website');
      expect(result.budget).toBe('$5,000');
      expect(result.skills).toContain('React');
      expect(result.skills).toContain('TypeScript');
    });

    it('extracts title using fallback h2 selector', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('h2', 'Simple Title'));
      container.appendChild(
        createElement('div', 'Desc', { 'data-test': 'Description' })
      );

      const result = extractor.extractJobInfo(container);
      expect(result.title).toBe('Simple Title');
    });

    it('extracts title using h3 fallback', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('h3', 'Fallback Title'));
      container.appendChild(
        createElement('div', 'A description', { 'data-test': 'Description' })
      );

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
    });

    it('returns default title when title element has empty text', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('h2', '  '));

      const result = extractor.extractJobInfo(container);
      expect(result.title).toBe('Unknown Title');
    });

    it('handles partial extraction (only title and description)', () => {
      const container = document.createElement('div');
      container.appendChild(
        createElement('h2', 'Partial Job', { itemprop: 'name' })
      );
      container.appendChild(
        createElement('div', 'Some description', { 'data-test': 'Description' })
      );

      const result = extractor.extractJobInfo(container);

      expect(result.title).toBe('Partial Job');
      expect(result.description).toBe('Some description');
      expect(result.budget).toBe('Not specified');
      expect(result.skills).toBe('Not specified');
    });

    it('extracts skills from data-test="token" elements', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('a', 'Python', { 'data-test': 'token' }));
      container.appendChild(createElement('a', 'Django', { 'data-test': 'token' }));

      const result = extractor.extractJobInfo(container);
      expect(result.skills).toContain('Python');
      expect(result.skills).toContain('Django');
    });

    it('trims whitespace from extracted text', () => {
      const container = document.createElement('div');
      container.appendChild(
        createElement('h2', '  Spaced Title  ', { itemprop: 'name' })
      );
      container.appendChild(
        createElement('div', '  Spaced Description  ', {
          'data-test': 'Description',
        })
      );
      container.appendChild(
        createElement('div', '  $1,000  ', { 'data-test': 'budget' })
      );

      const result = extractor.extractJobInfo(container);
      expect(result.title).toBe('Spaced Title');
      expect(result.description).toBe('Spaced Description');
      expect(result.budget).toBe('$1,000');
    });

    it('uses description from job-description-text selector', () => {
      const container = document.createElement('div');
      container.appendChild(
        createElement('div', 'Job description text', {
          'data-test': 'job-description-text',
        })
      );

      const result = extractor.extractJobInfo(container);
      expect(result.description).toBe('Job description text');
    });

    it('uses budget from is-fixed-price selector', () => {
      const container = document.createElement('div');
      container.appendChild(
        createElement('div', 'Fixed Price: $2,000', {
          'data-test': 'is-fixed-price',
        })
      );

      const result = extractor.extractJobInfo(container);
      expect(result.budget).toBe('Fixed Price: $2,000');
    });

    it('joins multiple skills with comma and space', () => {
      const container = document.createElement('div');
      container.appendChild(createElement('a', 'React', { class: 'air3-token' }));
      container.appendChild(
        createElement('a', 'Node.js', { class: 'air3-token' })
      );
      container.appendChild(
        createElement('a', 'PostgreSQL', { class: 'air3-token' })
      );

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

    it('always returns a complete JobInfo object (no undefined fields)', () => {
      const container = document.createElement('div');
      const result = extractor.extractJobInfo(container);

      const keys: (keyof JobInfo)[] = ['title', 'description', 'budget', 'skills'];
      for (const key of keys) {
        expect(result[key]).toBeDefined();
        expect(typeof result[key]).toBe('string');
      }
    });
  });

  // ── healthCheck ───────────────────────────────────────────────────────

  describe('healthCheck', () => {
    let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleWarnSpy.mockRestore();
    });

    it('returns "ok" for all fields when primary selectors match', () => {
      // Add a full drawer to the document body
      const drawer = createFullJobDrawer();
      drawer.classList.add('job-details-content');
      document.body.appendChild(drawer);

      const results = extractor.healthCheck();

      expect(results).toEqual(
        expect.arrayContaining([
          { field: 'title', status: 'ok' },
          { field: 'description', status: 'ok' },
          { field: 'budget', status: 'ok' },
          { field: 'skills', status: 'ok' },
        ])
      );

      document.body.removeChild(drawer);
    });

    it('returns "fallback" when primary selector fails but fallback works', () => {
      // Container with only fallback selectors (no itemprop="name" for title)
      const drawer = document.createElement('div');
      drawer.classList.add('job-details-content');
      drawer.appendChild(createElement('h2', 'Via H2 Fallback'));
      drawer.appendChild(
        createElement('div', 'Desc', { 'data-test': 'Description' })
      );

      document.body.appendChild(drawer);

      const results = extractor.healthCheck();
      const titleResult = results.find((r) => r.field === 'title');
      expect(titleResult?.status).toBe('fallback');

      document.body.removeChild(drawer);
    });

    it('returns "broken" when no selector in a chain matches', () => {
      // Empty body — none of the selectors will find anything
      const results = extractor.healthCheck();

      // In an empty page, all fields should be broken
      for (const r of results) {
        expect(r.status).toBe('broken');
      }
    });

    it('falls back to document.body when no drawer is present', () => {
      // No .job-details-content in the DOM; healthCheck should still run
      // against document.body without crashing
      const results = extractor.healthCheck();
      expect(results.length).toBe(SELECTOR_CHAINS.length);
    });
  });

  // ── logFallback ───────────────────────────────────────────────────────

  describe('logFallback', () => {
    it('logs a warning with the primary and fallback selector names', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const container = document.createElement('div');
      // No itemprop="name" but there is an h2
      container.appendChild(createElement('h2', 'Fallback Title'));

      extractor.extractJobInfo(container);

      // The title chain should have used a fallback, triggering logFallback
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Selector fallback for title')
      );

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
      const result = extractor.findJobDrawer();
      expect(result).toBeNull();
    });
  });
});