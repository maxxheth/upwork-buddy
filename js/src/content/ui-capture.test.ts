import { beforeEach, describe, expect, it } from 'vitest';
import { BUNDLED_SELECTORS, type SelectorConfig } from '../shared/selectors';
import {
  captureUiDiagnostic,
  cleanElementClasses,
  detectRepetitivePatterns,
  pruneDomForDiagnostics,
  testSelectorPatchOnDocument,
} from './ui-capture';

const MUTATED_SKILLS_DETAIL_HTML = `<!doctype html>
<html>
  <head><title>Senior Go Engineer - Upwork</title></head>
  <body>
    <main class="air3-page">
      <div class="job-details-content" data-v-abcdef12="">
        <h1 class="upwork-heading">Senior Go &amp; PostgreSQL Architect</h1>
        <section data-test="Description">
          <div class="text-body-sm">Need help architecting Chrome extension sync and Postgres pipelines. Contact alice@example.com for access.</div>
        </section>
        <div style="display:none" id="hidden-telemetry">secret hidden panel</div>
        <span hidden id="native-hidden">hidden badge</span>
        <svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>
        <script>window.__leak = "should be stripped";</script>
        <input type="password" name="api_token" value="super-secret-value-123" />
        <section class="skills-expertise">
          <h4 class="mb-2 mt-4">Skills and Expertise</h4>
          <ul class="new-skill-chips">
            <li class="air3-skill-chip p-2 m-1"><span>Go</span></li>
            <li class="air3-skill-chip p-2 m-1"><span>PostgreSQL</span></li>
            <li class="air3-skill-chip p-2 m-1"><span>Playwright</span></li>
          </ul>
        </section>
      </div>
    </main>
  </body>
</html>`;

describe('UI Diagnostic Capture & Self-Healing Selector Engine', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('strips display:none, hidden, svg, script while preserving visible nodes under jsdom zero-rect layout', () => {
    const parser = new DOMParser();
    const doc = parser.parseFromString(MUTATED_SKILLS_DETAIL_HTML, 'text/html');
    const root = doc.querySelector('main');
    expect(root).not.toBeNull();
    if (!root) return;

    const pruned = pruneDomForDiagnostics(root, { redactPii: true, viewType: 'job_detail' });
    expect(pruned.querySelector('#hidden-telemetry')).toBeNull();
    expect(pruned.querySelector('#native-hidden')).toBeNull();
    expect(pruned.querySelector('svg')).toBeNull();
    expect(pruned.querySelector('script')).toBeNull();
    expect(pruned.textContent).toContain('Senior Go & PostgreSQL Architect');
    expect(pruned.textContent).toContain('PostgreSQL');
    expect(pruned.textContent).toContain('Playwright');
  });

  it('strips utility/hash classes while retaining semantic air3 and skill classes', () => {
    const kept = cleanElementClasses(
      'air3-skill-chip p-2 m-1 mt-4 mb-2 px-3 d-flex data-v-99aabb custom-badge',
    );
    expect(kept).toContain('air3-skill-chip');
    expect(kept).toContain('custom-badge');
    expect(kept).not.toContain('p-2');
    expect(kept).not.toContain('m-1');
    expect(kept).not.toContain('mt-4');
    expect(kept).not.toContain('d-flex');
    expect(kept).not.toContain('data-v-99aabb');
  });

  it('detects repetitive sibling skill chips without data-test="Skill" and synthesizes ranked candidate selectors', () => {
    const doc = new DOMParser().parseFromString(MUTATED_SKILLS_DETAIL_HTML, 'text/html');
    const main = doc.querySelector('main');
    expect(main).not.toBeNull();
    if (!main) return;

    const pruned = pruneDomForDiagnostics(main, { redactPii: true, viewType: 'job_detail' });
    const patterns = detectRepetitivePatterns(pruned);
    const skillPattern = patterns.find(
      (p) => p.sample_items.includes('Go') && p.sample_items.includes('PostgreSQL'),
    );
    expect(skillPattern).toBeDefined();
    expect(skillPattern?.instance_count).toBe(3);

    const capture = captureUiDiagnostic(doc, {
      url: 'https://www.upwork.com/jobs/~0299887766/',
      view: 'job_detail',
      redactPii: true,
      brokenFields: ['skills'],
      selectorConfig: BUNDLED_SELECTORS,
    });

    const skillsDiagnosis = capture.broken_fields.find((bf) => bf.field === 'skills');
    expect(skillsDiagnosis).toBeDefined();
    expect(skillsDiagnosis?.nearest_heading).toContain('Skills and Expertise');
    expect(skillsDiagnosis?.candidates.length).toBeGreaterThan(0);

    const workingCandidate = skillsDiagnosis?.candidates.find((c) => {
      const sample = Array.isArray(c.sample_value) ? c.sample_value : [];
      return sample.includes('Go') && sample.includes('PostgreSQL');
    });
    expect(workingCandidate).toBeDefined();
  });

  it('redacts emails, password inputs, and sensitive message/draft content while preserving DOM structure', () => {
    const capture = captureUiDiagnostic(MUTATED_SKILLS_DETAIL_HTML, {
      url: 'https://www.upwork.com/jobs/~0299887766/',
      view: 'job_detail',
      redactPii: true,
      selectorConfig: BUNDLED_SELECTORS,
    });
    expect(capture.pruned_html).not.toContain('alice@example.com');
    expect(capture.pruned_html).not.toContain('super-secret-value-123');
    expect(capture.pruned_html).toContain('[REDACTED_EMAIL]');

    const messageHtml = `<!doctype html><html><body><main>
      <section data-test="message-thread">
        <div data-test="message-sender">Private Client Name</div>
        <div class="message-body">Hey Maxx, let us discuss secret pricing!</div>
        <textarea name="reply">Draft secret reply</textarea>
      </section>
    </main></body></html>`;
    const msgCapture = captureUiDiagnostic(messageHtml, {
      url: 'https://www.upwork.com/ab/messages/rooms/room_999',
      view: 'messages_thread',
      redactPii: true,
      selectorConfig: BUNDLED_SELECTORS,
    });
    expect(msgCapture.pruned_html).not.toContain('Private Client Name');
    expect(msgCapture.pruned_html).not.toContain('secret pricing');
    expect(msgCapture.pruned_html).not.toContain('Draft secret reply');
    expect(msgCapture.pruned_html).toContain('[REDACTED_TEXT');
  });

  it('dry-runs a proposed patch and detects regressions when sibling field breaks', () => {
    const brokenSkillsConfig: SelectorConfig = {
      ...BUNDLED_SELECTORS,
      views: {
        ...BUNDLED_SELECTORS.views,
        job_detail: {
          ...BUNDLED_SELECTORS.views.job_detail,
          fields: {
            ...BUNDLED_SELECTORS.views.job_detail.fields,
            title: {
              selectors: ['h1'],
              extract: 'full_text',
              required: true,
            },
            skills: {
              selectors: ['.definitely-missing-skill-selector'],
              extract: 'list',
              required: false,
            },
          },
        },
      },
    };

    const result = testSelectorPatchOnDocument(
      MUTATED_SKILLS_DETAIL_HTML,
      brokenSkillsConfig,
      'job_detail',
      'skills',
      {
        selectors: ['.new-skill-chips .air3-skill-chip span'],
        extract: 'list',
      },
      'https://www.upwork.com/jobs/~0299887766/',
    );

    expect(result.before_summary.status).toBe('BROKEN');
    expect(result.after_summary.status).toBe('HEALTHY');
    expect(result.matched_count).toBe(3);
    expect(result.sample_value).toEqual(['Go', 'PostgreSQL', 'Playwright']);
    expect(result.regressions).toEqual([]);

    const breakingTitle = testSelectorPatchOnDocument(
      MUTATED_SKILLS_DETAIL_HTML,
      brokenSkillsConfig,
      'job_detail',
      'title',
      {
        selectors: ['.non-existent-title'],
        extract: 'text',
        required: true,
      },
      'https://www.upwork.com/jobs/~0299887766/',
    );
    expect(breakingTitle.before_summary.status).toBe('HEALTHY');
    expect(breakingTitle.after_summary.status).toBe('BROKEN');
  });
});
