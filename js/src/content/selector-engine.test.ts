import { describe, expect, it } from 'vitest';
import {
  applyTransform,
  BLOCK_TAGS,
  extractDirectText,
  extractFieldValue,
  extractFullText,
  extractRenderedText,
  extractUpworkJobID,
  isJobNotFoundDocument,
  normalizeJobUrl,
  parseClientSpend,
  parseHtmlDocument,
  parseJobDetailFromDocument,
  parseJobListingsFromDocument,
  parseProposalCount,
} from './selector-engine';

const HIGHLIGHTED_SEARCH_HTML = `
<!DOCTYPE html>
<html><head><title>wordpress - Jobs | Upwork</title></head>
<body><main>
<article class="job-tile air3-card" data-test="JobTile">
  <div data-test="JobTileHeader">
    <small data-test="job-pubilshed-date"><span>Posted yesterday</span></small>
    <h2><a data-test="job-tile-title-link UpCLink" href="/jobs/On-Page-SEO-Expert-Audit-span-class-highlight-WordPress-span-Elementor_~022115332344639171/?referrer_url_path=/nx/search/jobs/">On-Page SEO Expert Needed — Audit + <span class="highlight">WordPress</span>/Elementor Implementation</a></h2>
  </div>
  <div data-test="JobTileDetails">
    <ul data-test="JobInfo"><li data-test="job-type-label"><strong>Hourly: $25.00 - $50.00</strong></li><li data-test="experience-level"><strong>Expert</strong></li><li data-test="duration-label"><strong>Est. time:</strong><span>1 to 3 months, Less than 30 hrs/week</span></li></ul>
    <div data-test="UpCLineClamp JobDescription"><div class="air3-line-clamp-wrapper"><div class="air3-line-clamp">
      <p class="mb-0 text-body-sm">We are looking for an experienced <span class="highlight">WordPress</span> developer
to rebuild our 25-35 page HVAC site (<span class="highlight">WordPress</span>, Elementor) with
   a focus on local SEO.</p>
    </div></div></div>
  </div>
</article>
<article class="job-tile air3-card" data-test="JobTile">
  <div data-test="JobTileHeader">
    <h2><a data-test="job-tile-title-link UpCLink" href="/jobs/Website-Migration-span-class-highlight-WordPress-span_~022111887415567641942/">Full Website Migration (GoDaddy to <span class="highlight">WordPress</span>)</a></h2>
  </div>
  <div data-test="JobTileDetails">
    <ul data-test="JobInfo"><li data-test="job-type-label"><strong>Fixed price</strong></li><li data-test="is-fixed-price"><span>Est. budget:</span><strong>$1,000.00</strong></li></ul>
    <div data-test="UpCLineClamp JobDescription"><div class="air3-line-clamp-wrapper"><div class="air3-line-clamp">
      <p class="mb-0 text-body-sm"><span class="highlight">WordPress</span> site needs moving off GoDaddy hosting.</p>
    </div></div></div>
  </div>
</article>
</main></body></html>
`;

const HIGHLIGHTED_DETAIL_HTML = `
<!DOCTYPE html>
<html><head><title>Restaurant website - Upwork</title></head>
<body><main>
<h1>Restaurant website build</h1>
<section data-test="Description">
  <p class="multiline-text">I need a freelancer to build a website for my restaurant using <span class="highlight">WordPress</span>.<br>Menu, bookings and a gallery.<br><br>See <a href="https://example.com">example.com</a>, our current site.</p>
</section>
<div><div data-cy="fixed-price"></div><strong>$500.00</strong></div>
</main></body></html>
`;

const SAMPLE_SEARCH_PAGE_HTML = `
<!DOCTYPE html>
<html>
<body>
  <main>
    <article class="job-tile" data-test="JobTile">
      <a data-test="job-tile-title-link" href="/jobs/Python-Engineer-span-class-highlight-FastAPI-span_~022111887415567641941/?referrer_url_path=/nx/search/jobs/">
        Python Engineer FastAPI
      </a>
      <div data-test="JobDescription"><p>Build scalable REST APIs using FastAPI and PostgreSQL.</p></div>
      <div data-test="job-type-label">Hourly: <strong>$50.00 - $75.00</strong></div>
      <div data-test="experience-level"><strong>Expert</strong></div>
      <div data-test="duration-label">Est. time:3 to 6 months</div>
      <div data-test="token"><span>Python</span></div>
      <div data-test="token"><span>FastAPI</span></div>
      <div data-test="job-pubilshed-date"><span>Posted 2 hours ago</span></div>
      <div data-qa="client-location">United States</div>
      <div data-test="proposals-tier">5 to 10</div>
      <div data-qa="client-rating">4.9 of 5</div>
    </article>
    <article class="job-tile" data-test="JobTile">
      <a data-test="job-tile-title-link" href="/jobs/WordPress-Elementor-Fix_~022111887415567641942/">
        WordPress Elementor Fix
      </a>
      <div data-test="JobDescription"><p>Fix broken layout on Elementor header.</p></div>
      <div data-test="is-fixed-price">Est. budget: $150.00</div>
      <div data-test="experience-level"><strong>Intermediate</strong></div>
      <div data-test="token"><span>WordPress</span></div>
      <div data-test="job-published-date"><span>Posted 1 day ago</span></div>
    </article>
  </main>
</body>
</html>
`;

const SAMPLE_DETAIL_PAGE_HTML = `
<!DOCTYPE html>
<html>
<head><title>Python Engineer FastAPI - UpWork</title></head>
<body>
  <h1>Python Engineer FastAPI</h1>
  <div data-test="Description">
    <p class="multiline-text">Summary We need an expert Python FastAPI developer to architect high-performance microservices.</p>
  </div>
  <li class="ca-item"><span class="title">Proposals:</span><span class="value">Less than 5</span></li>
  <li><div data-cy="clock-timelog">icon</div><strong>$60.00 - $80.00</strong></li>
  <li><div data-cy="expertise">icon</div><strong>Expert</strong></li>
  <li><div data-cy="duration2">icon</div><strong>More than 6 months</strong></li>
  <div class="skills-list"><span class="air3-line-clamp">Python</span><span class="air3-line-clamp">Docker</span></div>
  <div data-qa="client-spend">10k total spent</div>
  <div data-qa="client-hires">12 hires</div>
</body>
</html>
`;

const SAMPLE_DETAIL_HIGH_PROPOSALS_HTML = `
<!DOCTYPE html>
<html>
<head><title>WordPress Elementor Fix - UpWork</title></head>
<body>
  <h1>WordPress Elementor Fix</h1>
  <div data-test="Description">
    <p class="multiline-text">Summary Fix broken layout on Elementor header.</p>
  </div>
  <ul class="visitor client-activity-items list-unstyled">
    <li class="ca-item">
      <span class="title">Proposals:</span>
      <span class="help-icon"><span data-test="popper">Close the tooltipThis range includes relevant proposals</span></span>
      <span class="value">20 to 50</span>
    </li>
  </ul>
  <li><div data-cy="fixed-price">icon</div><strong>$150.00</strong></li>
  <li><div data-cy="expertise">icon</div><strong>Intermediate</strong></li>
  <div class="skills-list"><span class="air3-line-clamp">WordPress</span></div>
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

describe('Declarative Selector Engine (Scrapling / parser.py parity)', () => {
  it('defines exact 39 BLOCK_TAGS matching parser.py', () => {
    expect(BLOCK_TAGS.size).toBe(39);
    for (const tag of ['br', 'p', 'div', 'li', 'h1', 'h6', 'section', 'table', 'tr', 'td', 'ul']) {
      expect(BLOCK_TAGS.has(tag)).toBe(true);
    }
  });

  it('implements direct text, full text, and rendered_text with comment/script tail preservation', () => {
    const doc1 = parseHtmlDocument('<div>before<span>inside</span>after</div>');
    expect(extractDirectText(doc1.querySelector('div'))).toBe('before');

    const doc2 = parseHtmlDocument('<div><span>onlychild</span>after</div>');
    expect(extractDirectText(doc2.querySelector('div'))).toBe('');

    const doc3 = parseHtmlDocument('<div>first<!--c-->second<span>x</span>third</div>');
    expect(extractDirectText(doc3.querySelector('div'))).toBe('firstsecond');

    const doc4 = parseHtmlDocument('<div><span>A</span><span>B</span></div>');
    expect(extractFullText(doc4.querySelector('div'))).toBe('A B');

    const doc5 = parseHtmlDocument(
      '<div><p>Need <!-- note -->help<script>var x = 1;</script> with\u00a0<b>Woo</b>Commerce</p><p>Second   paragraph</p></div>',
    );
    expect(extractRenderedText(doc5.querySelector('div'))).toBe(
      'Need help with WooCommerce Second paragraph',
    );
  });

  it('parses HIGHLIGHTED_SEARCH_HTML with exact Scrapling parity', () => {
    const jobs = parseJobListingsFromDocument(HIGHLIGHTED_SEARCH_HTML);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].title).toBe(
      'On-Page SEO Expert Needed — Audit + WordPress/Elementor Implementation',
    );
    expect(jobs[0].url).toBe(
      'https://www.upwork.com/jobs/On-Page-SEO-Expert-Audit-WordPress-Elementor_~022115332344639171/',
    );
    expect(jobs[0].hourly_rate).toBe('$25.00 - $50.00');
    expect(jobs[0].duration).toBe('1 to 3 months, Less than 30 hrs/week');
    expect(jobs[0].description).toBe(
      'We are looking for an experienced WordPress developer to rebuild our 25-35 page HVAC site (WordPress, Elementor) with a focus on local SEO.',
    );

    expect(jobs[1].title).toBe('Full Website Migration (GoDaddy to WordPress)');
    expect(jobs[1].budget).toBe('$1,000.00');
    expect(jobs[1].hourly_rate).toBeNull();
    expect(jobs[1].description).toBe('WordPress site needs moving off GoDaddy hosting.');
  });

  it('parses HIGHLIGHTED_DETAIL_HTML joining inline tags and separating <br>', () => {
    const job = parseJobDetailFromDocument(HIGHLIGHTED_DETAIL_HTML);
    expect(job).not.toBeNull();
    expect(job?.description).toBe(
      'I need a freelancer to build a website for my restaurant using WordPress. Menu, bookings and a gallery. See example.com, our current site.',
    );
    expect(job?.budget).toBe('$500.00');
  });

  it('parses SAMPLE_SEARCH_PAGE_HTML, SAMPLE_DETAIL_PAGE_HTML, SAMPLE_DETAIL_HIGH_PROPOSALS_HTML, and SAMPLE_JOB_DETAIL_HTML', () => {
    const searchJobs = parseJobListingsFromDocument(SAMPLE_SEARCH_PAGE_HTML);
    expect(searchJobs).toHaveLength(2);
    expect(searchJobs[0].title).toBe('Python Engineer FastAPI');
    expect(searchJobs[0].url).toBe(
      'https://www.upwork.com/jobs/Python-Engineer-FastAPI_~022111887415567641941/',
    );
    expect(searchJobs[0].hourly_rate).toBe('$50.00 - $75.00');
    expect(searchJobs[0].skills).toEqual(['Python', 'FastAPI']);
    expect(searchJobs[0].client_rating).toBe(4.9);
    expect(searchJobs[1].budget).toBe('$150.00');

    const detail1 = parseJobDetailFromDocument(SAMPLE_DETAIL_PAGE_HTML);
    expect(detail1).not.toBeNull();
    expect(detail1?.description).toBe(
      'We need an expert Python FastAPI developer to architect high-performance microservices.',
    );
    expect(detail1?.proposals).toBe('Less than 5');
    expect(detail1?.client_spent).toBe('10k');
    expect(detail1?.client_hires).toBe(12);

    const detail2 = parseJobDetailFromDocument(SAMPLE_DETAIL_HIGH_PROPOSALS_HTML);
    expect(detail2).not.toBeNull();
    expect(detail2?.proposals).toBe('20 to 50');

    const detail3 = parseJobDetailFromDocument(
      SAMPLE_JOB_DETAIL_HTML,
      undefined,
      '/jobs/Senior-WP_~01abc123/',
    );
    expect(detail3).not.toBeNull();
    expect(detail3?.hours_per_week).toBe('30+ hrs/week');
    expect(detail3?.hourly_rate).toBe('$45 - $65');
    expect(detail3?.skills).toEqual(['WordPress', 'WooCommerce']);
    expect(detail3?.proposals).toBe('10 to 15');
    expect(detail3?.client_spent).toBe('$25.5K');
    expect(detail3?.client_hires).toBe(14);
  });

  it('implements all 9 transforms with strict Python float/int semantics', () => {
    expect(
      normalizeJobUrl(
        '/jobs/Off-span-class-highlight-WordPress-span-amp-Host_~022112225892746435112/?referrer_url_path=/nx/search/jobs/',
      ),
    ).toBe('https://www.upwork.com/jobs/Off-WordPress-Host_~022112225892746435112/');

    expect(applyTransform('Est. budget: $1,250.00', 'strip_est_budget_prefix')).toBe('$1,250.00');
    expect(applyTransform('Est. time: 1 to 3 months', 'strip_est_time_prefix')).toBe(
      '1 to 3 months',
    );
    expect(applyTransform('Summary Build an API', 'strip_summary_prefix')).toBe('Build an API');
    expect(applyTransform('$25.5K total spent', 'strip_total_suffix')).toBe('$25.5K');
    expect(
      applyTransform('Proposals: 5 to 10 Close the tooltip blah', 'clean_proposals_text'),
    ).toBe('5 to 10');
    expect(applyTransform('4.9 of 5', 'first_token_float')).toBe(4.9);
    expect(applyTransform('4.9px', 'first_token_float')).toBe('4.9px');
    expect(applyTransform('12 hires', 'first_token_int')).toBe(12);
    expect(applyTransform('12hires', 'first_token_int')).toBe('12hires');
    expect(applyTransform('12.5', 'first_token_int')).toBe('12.5');
    expect(applyTransform('Rating is 4.85 out of 5.', 'rating_out_of_5_float')).toBe(4.85);
    expect(
      extractFieldValue(parseHtmlDocument('<div>4.9px</div>'), {
        selectors: ['div'],
        extract: 'text',
        transforms: ['first_token_float'],
      }),
    ).toBe('4.9px');
  });

  it('detects 404 headings, empty soft-404 shells, and helper parsers cleanly', () => {
    const html404Heading =
      '<html><head><title>Job</title></head><body><h1>Job not found</h1></body></html>';
    const html404Shell = '<html><head><title></title></head><body>   </body></html>';
    expect(isJobNotFoundDocument(html404Heading)).toBe(true);
    expect(isJobNotFoundDocument(html404Shell)).toBe(true);
    expect(parseJobDetailFromDocument(html404Heading)).toBeNull();
    expect(parseJobDetailFromDocument(html404Shell)).toBeNull();

    expect(extractUpworkJobID('https://www.upwork.com/jobs/Test_~022115332344639171/')).toBe(
      '~022115332344639171',
    );
    expect(parseProposalCount('Less than 5')).toBe(4);
    expect(parseProposalCount('10 to 15')).toBe(15);
    expect(parseProposalCount('50+')).toBe(999);
    expect(parseClientSpend('$25.5K total spent')).toBe(25500);
    expect(parseClientSpend('$1.2m')).toBe(1200000);
  });

  it('falls back to extractFullText in list mode when direct text is empty while preserving direct text first', () => {
    const html = `
      <!DOCTYPE html>
      <html><body><main>
        <h1>Authenticated Detail</h1>
        <div data-test="Description"><p class="multiline-text">Summary Go job.</p></div>
        <ul class="client-activity-items">
          <li class="ca-item"><span class="title">Proposals:</span><span class="value">5 to 10</span></li>
          <li class="ca-item"><span class="title">Interviewing:</span><span class="value">2</span></li>
        </ul>
        <ul data-test="screening-questions">
          <li><span class="required">*</span>Describe your <b>API</b> experience?</li>
        </ul>
        <ul class="qualification-items">
          <li><span class="text-success">✓</span> Location: United States</li>
        </ul>
        <div data-test="attachments">
          <a href="https://www.upwork.com/att/spec.pdf?dl=1"><span class="icon"></span>spec.pdf</a>
        </div>
      </main></body></html>
    `;
    const parsed = parseJobDetailFromDocument(html);
    expect(parsed).not.toBeNull();
    expect(parsed?.client_activity).toEqual(['Proposals: 5 to 10', 'Interviewing: 2']);
    expect(parsed?.screening_questions).toEqual(['* Describe your API experience?']);
    expect(parsed?.qualifications).toEqual(['✓ Location: United States']);
    expect(parsed?.attachments).toEqual(['spec.pdf']);

    // Direct text still takes precedence when non-empty on list items
    const mixedDoc = parseHtmlDocument(
      '<ul><li>direct<span>child</span></li><li><span>only-child</span></li></ul>',
    );
    expect(
      extractFieldValue(mixedDoc, {
        selectors: ['li'],
        extract: 'list',
      }),
    ).toEqual(['direct', 'only-child']);
  });

  it('rejects non-http(s) URLs in normalizeJobUrl and handles lowercase est. time prefix', () => {
    expect(normalizeJobUrl('javascript:alert(1)')).toBe('');
    expect(normalizeJobUrl('data:text/html,<script>1</script>')).toBe('');
    expect(applyTransform('est. time: Less than 1 month', 'strip_est_time_prefix')).toBe(
      'Less than 1 month',
    );
  });

  it('extracts proposals_insights_v2 ca_item_value without falling back to Bid range across multiple sections', () => {
    const v2Doc = parseHtmlDocument(`
      <div data-test="proposals-insights-v2-job-activity">
        <div>
          <div data-test="proposals-insights-v2-job-activity-section">
            <div><div><div>Bid range</div></div><button type="button" data-test="proposals-insights-v2-job-activity-section-toggle"></button></div>
            <div data-ev-sublocation="!collapse">High $50, Avg $35, Low $20</div>
          </div>
          <div data-test="proposals-insights-v2-job-activity-section">
            <div><div><div>Proposals</div> <div>(1)</div></div><button type="button"></button></div>
          </div>
          <div data-test="proposals-insights-v2-job-activity-section">
            <div><div><div>Invites</div> <div>(0)</div></div><button type="button"></button></div>
          </div>
          <div data-test="proposals-insights-v2-job-activity-section">
            <div><div><div>Interviews</div> <div>(0)</div></div></div>
            <div data-ev-sublocation="!collapse"><div></div></div>
          </div>
        </div>
      </div>
    `);

    expect(
      extractFieldValue(v2Doc, {
        selectors: ["[data-test='proposals-insights-v2-job-activity-section']"],
        extract: 'ca_item_value',
        label_contains: 'Proposals',
        transforms: ['clean_proposals_text'],
      }),
    ).toBe('1');

    const missingProposalsDoc = parseHtmlDocument(`
      <div data-test="proposals-insights-v2-job-activity">
        <div>
          <div data-test="proposals-insights-v2-job-activity-section">
            <div><div><div>Bid range</div></div><button type="button" data-test="proposals-insights-v2-job-activity-section-toggle"></button></div>
            <div data-ev-sublocation="!collapse">High $50, Avg $35, Low $20</div>
          </div>
          <div data-test="proposals-insights-v2-job-activity-section">
            <div><div><div>Invites</div> <div>(0)</div></div><button type="button"></button></div>
          </div>
        </div>
      </div>
    `);

    expect(
      extractFieldValue(missingProposalsDoc, {
        selectors: ["[data-test='proposals-insights-v2-job-activity-section']"],
        extract: 'ca_item_value',
        label_contains: 'Proposals',
        transforms: ['clean_proposals_text'],
      }),
    ).toBeNull();
  });

  it('unwraps parenthesized proposal counts in clean_proposals_text and parseProposalCount', () => {
    expect(applyTransform('(1)', 'clean_proposals_text')).toBe('1');
    expect(applyTransform('(15)', 'clean_proposals_text')).toBe('15');
    expect(applyTransform('(Less than 5)', 'clean_proposals_text')).toBe('Less than 5');
    expect(applyTransform('(5 to 10)', 'clean_proposals_text')).toBe('5 to 10');

    expect(parseProposalCount('(1)')).toBe(1);
    expect(parseProposalCount('(15)')).toBe(15);
    expect(parseProposalCount('(Less than 5)')).toBe(4);
    expect(parseProposalCount('(5 to 10)')).toBe(10);
  });
});
