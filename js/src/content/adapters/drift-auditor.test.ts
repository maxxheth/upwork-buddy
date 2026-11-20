import { describe, expect, it } from 'vitest';
import { UpWorkPageBlueprintSchema } from '../../shared/protocol';
import { BUNDLED_SELECTORS, type SelectorConfig } from '../../shared/selectors';
import { parseHtmlDocument } from '../selector-engine';
import baselineFixture from './__fixtures__/search-results-baseline.json';
import { buildPageBlueprint, computeOverallAuditStatus, DriftAuditor } from './drift-auditor';

const SAMPLE_SEARCH_HTML = `
<!DOCTYPE html>
<html>
<head><title>WordPress Jobs - UpWork</title></head>
<body>
<nav class="air3-nav-freelancer">
    <div data-test="nav-user-menu">User Menu</div>
</nav>
<main>
    <article class="job-tile">
        <a data-test="job-tile-title-link" href="/jobs/~01abc123">Senior WordPress Developer</a>
        <div data-test="JobDescription">
            <p>Looking for a WordPress / ACF expert to optimize performance.</p>
        </div>
        <div data-test="job-type-label">
            <strong>$50 - $75</strong>
        </div>
        <div data-test="experience-level">
            <strong>Expert</strong>
        </div>
        <div data-test="duration-label">1 to 3 months</div>
        <div class="skills-list">
            <button data-test="token"><span>WordPress</span></button>
            <button data-test="token"><span>PHP</span></button>
        </div>
        <small data-test="job-pubilshed-date"><span>Posted 2 hours ago</span></small>
        <span data-qa="payment-verified">Payment Verified</span>
        <span data-qa="client-rating">4.9 of 5 stars</span>
        <span data-test="proposals-tier"><strong>5 to 10</strong></span>
    </article>
</main>
<script>window.__secret = "keep-in-live-dom";</script>
</body>
</html>
`;

const SAMPLE_MUTATED_HTML = `
<!DOCTYPE html>
<html>
<head><title>WordPress Jobs - UpWork</title></head>
<body>
<main>
    <article class="job-tile">
        <a data-test="job-tile-title-link" href="/jobs/~01abc123">Senior WordPress Developer</a>
        <small data-test="job-published-date"><span>Posted 2 hours ago</span></small>
    </article>
</main>
</body>
</html>
`;

const SAMPLE_JOB_DETAIL_HTML = `
<!DOCTYPE html>
<html>
<head><title>Job Details - Senior WordPress Engineer</title></head>
<body>
<main>
    <h1>Senior WordPress Engineer</h1>
    <div data-test="Description">
        <p class="multiline-text">We need a developer to refactor our WooCommerce checkout.</p>
    </div>
    <div class="posted-on-line"><span>Posted 1 day ago</span></div>
    <ul>
        <li>
            <div data-cy="clock-timelog"></div>
            <div><strong>$45</strong> - <strong>$65</strong></div>
        </li>
        <li>
            <div data-cy="expertise"></div>
            <strong>Intermediate</strong>
        </li>
        <li>
            <div data-cy="duration2"></div>
            <strong>Less than 1 month</strong>
        </li>
        <li>
            <div data-cy="clock-hourly"></div>
            <strong>30+ hrs/week</strong>
        </li>
    </ul>
    <section data-v-3b2c2248>
        <div class="skills-list">
            <div class="air3-line-clamp">WordPress</div>
            <div class="air3-line-clamp">WooCommerce</div>
        </div>
    </section>
    <ul>
        <li class="ca-item">
            <span class="title">Proposals:</span>
            <span class="help-icon"><span data-test="popper">Close the tooltipThis range includes relevant proposals</span></span>
            <span class="value">10 to 15</span>
        </li>
    </ul>
    <li data-qa="client-location">United States</li>
    <strong data-qa="client-spend">$25.5K total spent</strong>
    <div data-qa="client-hires">14 hires</div>
</main>
</body>
</html>
`;

describe('UI Drift Auditor & DOM Blueprinting', () => {
  it('builds page blueprint without mutating live DOM and extracts card blueprint & hooks', () => {
    const doc = parseHtmlDocument(SAMPLE_SEARCH_HTML);
    const scriptCountBefore = doc.querySelectorAll('script').length;
    expect(scriptCountBefore).toBe(1);

    const blueprint = buildPageBlueprint(doc, {
      url: 'https://www.upwork.com/nx/search/jobs/?q=wordpress',
      isAuthenticated: true,
    });

    // Live document must remain completely unmutated
    expect(doc.querySelectorAll('script').length).toBe(1);

    expect(blueprint.view_type).toBe('search_results');
    expect(blueprint.is_authenticated).toBe(true);
    expect(blueprint.job_card_blueprint?.total_cards_detected).toBe(1);
    expect(blueprint.job_card_blueprint?.sample_card_data.title).toBe('Senior WordPress Developer');
    expect(blueprint.job_card_blueprint?.sample_card_data.proposals).toBe('5 to 10');

    const hookNames = blueprint.all_hooks.map((h) => h.name);
    expect(hookNames).toContain('job-tile-title-link');
    expect(hookNames).toContain('JobDescription');
    expect(hookNames).toContain('job-pubilshed-date');
    expect(hookNames).toContain('payment-verified');
  });

  it('detects HEALTHY, FRAGILE, DEGRADED, and BROKEN selectors with replacement suggestions and unmapped auth discovery', () => {
    const bp = buildPageBlueprint(SAMPLE_SEARCH_HTML, {
      url: 'https://www.upwork.com/nx/search/jobs/?q=wordpress',
      isAuthenticated: true,
    });
    const report = new DriftAuditor(bp, SAMPLE_SEARCH_HTML).audit();

    const fragile = report.audits.filter((a) => a.status === 'FRAGILE').map((a) => a.target_field);
    expect(fragile).toContain('posted');

    const healthy = report.audits.filter((a) => a.status === 'HEALTHY').map((a) => a.target_field);
    expect(healthy).toContain('title_and_url');
    expect(healthy).toContain('description');
    expect(healthy).toContain('hourly_rate');
    expect(healthy).toContain('proposals');

    const proposalsEntry = report.audits.find((a) => a.target_field === 'proposals');
    expect(proposalsEntry?.sample_extracted_value).toBe('5 to 10');

    const candidateNames = report.discovered_candidates.map((c) => c.hook_name);
    expect(candidateNames).toContain('payment-verified');

    // Mutated HTML: job-pubilshed-date fixed -> BROKEN with replacement [data-test='job-published-date'] span
    const mutatedBp = buildPageBlueprint(SAMPLE_MUTATED_HTML, {
      url: 'https://www.upwork.com/nx/search/jobs/?q=wordpress',
      isAuthenticated: true,
    });
    const mutatedReport = new DriftAuditor(mutatedBp, SAMPLE_MUTATED_HTML).audit();
    const postedAudit = mutatedReport.audits.find((a) => a.target_field === 'posted');
    expect(postedAudit?.status).toBe('BROKEN');
    expect(postedAudit?.suggested_replacement).toBe("[data-test='job-published-date'] span");
    expect(computeOverallAuditStatus(mutatedReport)).toBe('BROKEN');

    // Job detail fragile Vue scope hash
    const detailBp = buildPageBlueprint(SAMPLE_JOB_DETAIL_HTML, {
      url: 'https://www.upwork.com/jobs/~01abc123/',
      isAuthenticated: true,
    });
    const detailReport = new DriftAuditor(detailBp, SAMPLE_JOB_DETAIL_HTML).audit();
    const skillsAudit = detailReport.audits.find((a) => a.target_field === 'skills');
    expect(skillsAudit?.status).toBe('FRAGILE');
    expect(skillsAudit?.suggested_replacement).toBe('.skills-list .air3-line-clamp');
    expect(detailReport.audits.find((a) => a.target_field === 'hours_per_week')?.status).toBe(
      'HEALTHY',
    );
    // auth_only v2 fields (payment_verified, screening_questions, etc.) are absent in this public fixture
    expect(computeOverallAuditStatus(detailReport)).toBe('BROKEN');
  });

  it('parses search-results-baseline.json and detects REMOVED, FREQUENCY_DROPPED, and ADDED diffs capped at 10', () => {
    const parsedBaseline = UpWorkPageBlueprintSchema.parse(baselineFixture);
    expect(parsedBaseline.view_type).toBe('search_results');
    expect(parsedBaseline.job_card_blueprint?.total_cards_detected).toBe(10);

    const currBp = buildPageBlueprint(SAMPLE_SEARCH_HTML, {
      url: 'https://www.upwork.com/nx/search/jobs/?q=wordpress',
      isAuthenticated: true,
    });
    const report = new DriftAuditor(currBp, SAMPLE_SEARCH_HTML, undefined, parsedBaseline).audit();
    expect(report.baseline_diffs.length).toBeGreaterThan(0);
    expect(report.baseline_diffs.length).toBeLessThanOrEqual(10);
    expect(report.baseline_diffs.some((d) => d.change_type === 'REMOVED')).toBe(true);
    expect(report.breaking_changes_detected.some((b) => b.startsWith('BASELINE DRIFT:'))).toBe(
      true,
    );

    // Also test ADDED + FREQUENCY_DROPPED specifically against synthetic baseline
    const customBaseline = UpWorkPageBlueprintSchema.parse({
      view_type: 'search_results',
      url: 'https://www.upwork.com/nx/search/jobs/',
      title: 'Jobs',
      timestamp: '2026-11-19T00:00:00Z',
      all_hooks: [
        { hook_type: 'data-test', name: 'token', tag: 'button', frequency: 10, sample_values: [] },
        {
          hook_type: 'data-test',
          name: 'removed-hook',
          tag: 'div',
          frequency: 3,
          sample_values: [],
        },
      ],
    });
    const diffReport = new DriftAuditor(
      currBp,
      SAMPLE_SEARCH_HTML,
      undefined,
      customBaseline,
    ).audit();
    expect(
      diffReport.baseline_diffs.some(
        (d) => d.hook_name === 'removed-hook' && d.change_type === 'REMOVED',
      ),
    ).toBe(true);
    expect(
      diffReport.baseline_diffs.some(
        (d) => d.hook_name === 'token' && d.change_type === 'FREQUENCY_DROPPED',
      ),
    ).toBe(true);
  });

  it('does not report registered .air3-* classes or #id selectors in discovered_candidates', () => {
    const html = `
      <!doctype html><html><body>
        <main>
          <article class="job-tile">
            <a data-test="job-tile-title-link" href="/jobs/~01xyz">Go Engineer</a>
            <span class="air3-token-client-spent">$50K spent</span>
            <span id="client-verified-badge">Payment verified</span>
          </article>
        </main>
      </body></html>
    `;
    const customConfig: SelectorConfig = {
      ...BUNDLED_SELECTORS,
      views: {
        ...BUNDLED_SELECTORS.views,
        search_listings: {
          ...BUNDLED_SELECTORS.views.search_listings,
          fields: {
            ...BUNDLED_SELECTORS.views.search_listings.fields,
            client_spent: {
              selectors: ['.air3-token-client-spent'],
              extract: 'text',
              required: false,
            },
            payment_verified: {
              selectors: ['#client-verified-badge'],
              extract: 'text',
              required: false,
            },
          },
        },
      },
    };
    const bp = buildPageBlueprint(html, {
      url: 'https://www.upwork.com/nx/search/jobs/',
      isAuthenticated: true,
    });
    const report = new DriftAuditor(bp, html, customConfig).audit();
    const candidateHooks = report.discovered_candidates.map((c) => c.hook_name);
    expect(candidateHooks).not.toContain('air3-token-client-spent');
    expect(candidateHooks).not.toContain('client-verified-badge');
  });

  it('infers job_detail from pathname even when referrer_url_path or q= query params are present', () => {
    const doc = parseHtmlDocument(
      '<html><body><main><div data-test="job-details"><h1>Build 2FA Flow</h1></div></main></body></html>',
    );

    const bpSearchRef = buildPageBlueprint(doc, {
      url: 'https://www.upwork.com/jobs/Implement-2FA-in-React_~022115332344639171/?referrer_url_path=/nx/search/jobs/?q=react',
      isAuthenticated: true,
    });
    expect(bpSearchRef.view_type).toBe('job_detail');

    const bpMsgRef = buildPageBlueprint(doc, {
      url: 'https://www.upwork.com/jobs/Build-Chat_~022115332344639171/?referrer_url_path=/ab/messages/rooms/room_1',
      isAuthenticated: true,
    });
    expect(bpMsgRef.view_type).toBe('job_detail');
  });
});
