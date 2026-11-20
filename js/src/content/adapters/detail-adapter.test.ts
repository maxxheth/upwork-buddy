import { describe, expect, it } from 'vitest';
import { parseHtmlDocument } from '../selector-engine';
import { detailToJobInfo, detailToUpsertPayload, extractJobDetail } from './detail-adapter';

function buildRichDetailBodyHtml(): string {
  return `
    <nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>
    <div class="job-details-card">
      <h1><span class="flex-1">Senior Go &amp; Postgres Architect</span></h1>
      <div class="posted-on-line"><span>Posted 3 hours ago</span></div>
      <div data-test="Description">
        <p class="multiline-text">Summary Build a local MCP server in Go 1.26 with Postgres 17.</p>
      </div>
      <ul>
        <li><div data-cy="clock-timelog"></div><strong>$70.00</strong> - <strong>$95.00</strong></li>
        <li><div data-cy="expertise"></div><strong>Expert</strong></li>
        <li><div data-cy="duration2"></div><strong>3 to 6 months</strong></li>
        <li><div data-cy="clock-hourly"></div><strong>30+ hrs/week</strong></li>
      </ul>
      <section data-v-3b2c2248>
        <div class="skills-list">
          <div class="air3-line-clamp">Go</div>
          <div class="air3-line-clamp">PostgreSQL</div>
        </div>
      </section>
      <ul class="client-activity-items">
        <li class="ca-item">
          <span class="title">Proposals:</span>
          <span class="help-icon"><span data-test="popper">Close the tooltipThis range includes relevant proposals</span></span>
          <span class="value">5 to 10</span>
        </li>
        <li class="ca-item"><span class="title">Last viewed by client:</span><span class="value">12 minutes ago</span></li>
        <li class="ca-item"><span class="title">Interviewing:</span><span class="value">2</span></li>
        <li class="ca-item"><span class="title">Invites sent:</span><span class="value">4</span></li>
        <li class="ca-item"><span class="title">Unanswered invites:</span><span class="value">1</span></li>
      </ul>
      <div data-test="connects-to-send">Send a proposal for: <strong>16</strong> Connects</div>
      <div data-test="about-client-container">
        <div class="payment-verified">Payment method verified</div>
        <div data-testid="buyer-rating">
          <div class="air3-rating-background"><span class="sr-only">Rating is 4.95 out of 5.</span></div>
          <span class="nowrap">5.00 of 1 review</span>
        </div>
        <ul>
          <li data-qa="client-location">United States</li>
          <li data-qa="client-job-posting-stats">12 jobs posted, 75% hire rate</li>
          <li data-qa="client-spend">$42.5K total spent</li>
          <li data-qa="client-hires">9 hires</li>
          <li data-qa="client-hourly-rate">$58.25 /hr avg hourly rate paid</li>
        </ul>
      </div>
      <ol data-test="screening-questions">
        <li>Describe your Go MCP experience *</li>
        <li>Share an architecture diagram link</li>
      </ol>
      <div data-test="attachments">
        <a href="/att/12345/spec.pdf">spec.pdf</a>
        <a href="javascript:alert(1)">bad.js</a>
      </div>
      <ul class="qualification-items">
        <li><span class="text-success">✓</span>Job Success Score: At least 90%</li>
        <li><span class="text-danger">✗</span>English Level: Native</li>
      </ul>
    </div>
  `;
}

describe('Full Job Detail Enrichment Adapter', () => {
  it('extracts all 22 upwork.yaml fields + client_avg_hourly identically from standalone page and .job-details-content drawer', () => {
    const standaloneHtml = `<!DOCTYPE html><html><body><main>${buildRichDetailBodyHtml()}</main></body></html>`;
    const drawerHtml = `<!DOCTYPE html><html><body><div class="job-details-content">${buildRichDetailBodyHtml()}</div></body></html>`;

    const url =
      'https://www.upwork.com/jobs/Senior-Go-Architect_~022115332344639171/?referrer_url_path=/nx/search/jobs/';

    for (const [isDrawer, html] of [
      [false, standaloneHtml],
      [true, drawerHtml],
    ] as const) {
      const doc = parseHtmlDocument(html);
      const res = extractJobDetail(doc, {
        url,
        requireDrawer: isDrawer,
        location: { href: url, pathname: '/jobs/Senior-Go-Architect_~022115332344639171/' },
      });

      expect(res.ok).toBe(true);
      expect(res.detail).toBeDefined();
      const d = res.detail;
      expect(d?.title).toBe('Senior Go & Postgres Architect');
      expect(d?.description).toBe('Build a local MCP server in Go 1.26 with Postgres 17.');
      expect(d?.upwork_job_id).toBe('~022115332344639171');
      expect(d?.contract_type).toBe('hourly');
      expect(d?.rate_range).toBe('$70.00 - $95.00');
      expect(d?.rate_min).toBe('$70.00');
      expect(d?.rate_max).toBe('$95.00');
      expect(d?.budget).toBe('$70.00 - $95.00/hr');
      expect(d?.hours_per_week).toBe('30+ hrs/week');
      expect(d?.duration).toBe('3 to 6 months');
      expect(d?.experience_level).toBe('Expert');
      expect(d?.skills).toEqual(['Go', 'PostgreSQL']);
      expect(d?.posted_text).toBe('Posted 3 hours ago');
      expect(d?.proposals_tier).toBe('5 to 10');
      expect(d?.proposals_count).toBe(10);
      expect(d?.connects_required).toBe(16);
      expect(d?.client_country).toBe('United States');
      expect(d?.client_rating).toBe(4.95);
      expect(d?.client_reviews).toBe(1);
      expect(d?.payment_verified).toBe(true);
      expect(d?.client_hire_rate).toBe(75);
      expect(d?.client_spent).toBe('$42.5K');
      expect(d?.client_spent_usd).toBe(42500);
      expect(d?.client_hires).toBe(9);
      expect(d?.client_avg_hourly).toBe('$58.25/hr');
      expect(d?.client_activity).toEqual({
        interviewing: 2,
        invites_sent: 4,
        unanswered_invites: 1,
        last_viewed: '12 minutes ago',
        avg_hourly_rate_paid: '$58.25/hr',
      });
      expect(d?.screening_questions).toEqual([
        { index: 0, prompt: 'Describe your Go MCP experience *', required: true },
        { index: 1, prompt: 'Share an architecture diagram link', required: false },
      ]);
      expect(d?.attachments).toEqual([
        { filename: 'spec.pdf', url: 'https://www.upwork.com/att/12345/spec.pdf' },
      ]);
      expect(d?.qualifications).toEqual([
        { name: 'Job Success Score', value: 'At least 90%', met: true },
        { name: 'English Level', value: 'Native', met: false },
      ]);

      if (d) {
        const info = detailToJobInfo(d);
        expect(info.title).toBe('Senior Go & Postgres Architect');
        expect(info.skills).toBe('Go, PostgreSQL');

        const payload = detailToUpsertPayload(d);
        expect(payload.client_avg_hourly).toBe('$58.25/hr');
        expect(payload.client_activity?.avg_hourly_rate_paid).toBe('$58.25/hr');
        expect(payload.last_enriched_at).toBeTruthy();
      }
    }
  });

  it('handles unverified/missing payment_verified, 404/private fast-fail, rate limits, and HUMAN_ACTION_REQUIRED', () => {
    const unverifiedDoc = parseHtmlDocument(`
      <html><body><main>
        <h1>Fixed Price Job</h1>
        <div data-test="Description"><p class="multiline-text">Fix bug.</p></div>
        <div data-cy="fixed-price"></div><strong>$250.00</strong>
        <div data-qa="payment-verified">Payment method not verified</div>
      </main></body></html>
    `);
    const unvRes = extractJobDetail(unverifiedDoc, {
      url: 'https://www.upwork.com/jobs/Fix-Bug_~0199999/',
    });
    expect(unvRes.ok).toBe(true);
    expect(unvRes.detail?.payment_verified).toBe(false);
    expect(unvRes.detail?.contract_type).toBe('fixed');
    expect(unvRes.detail?.budget).toBe('$250.00 fixed');

    const notFoundDoc = parseHtmlDocument('<html><body><h1>This job is private</h1></body></html>');
    const nfRes = extractJobDetail(notFoundDoc, {
      url: 'https://www.upwork.com/jobs/~0199999/',
    });
    expect(nfRes.ok).toBe(false);
    expect(nfRes.errorCode).toBe('NOT_FOUND');

    const rateLimitDoc = parseHtmlDocument(
      '<html><body><div class="air3-alert">Too many requests (HTTP 429)</div></body></html>',
    );
    const rlRes = extractJobDetail(rateLimitDoc, {
      url: 'https://www.upwork.com/jobs/~0199999/',
    });
    expect(rlRes.ok).toBe(false);
    expect(rlRes.errorCode).toBe('RATE_LIMITED');

    const challengeDoc = parseHtmlDocument(
      '<html><body><div data-test="two-factor-auth">2FA</div></body></html>',
    );
    const chRes = extractJobDetail(challengeDoc, {
      url: 'https://www.upwork.com/jobs/~0199999/',
    });
    expect(chRes.ok).toBe(false);
    expect(chRes.errorCode).toBe('HUMAN_ACTION_REQUIRED');
  });

  it('extracts client_activity cleanly when span.title/span.value wrap text in <strong>', () => {
    const doc = parseHtmlDocument(`
      <html><body><main>
        <h1>Wrapped Activity Job</h1>
        <div data-test="Description"><p class="multiline-text">Build API.</p></div>
        <ul class="client-activity-items">
          <li class="ca-item"><span class="title"><strong>Interviewing:</strong></span><span class="value"><strong>3</strong></span></li>
          <li class="ca-item"><span class="title"><strong>Invites sent:</strong></span><span class="value"><strong>5</strong></span></li>
          <li class="ca-item"><span class="title"><strong>Unanswered invites:</strong></span><span class="value"><strong>2</strong></span></li>
          <li class="ca-item"><span class="title"><strong>Last viewed by client:</strong></span><span class="value"><strong>8 minutes ago</strong></span></li>
        </ul>
      </main></body></html>
    `);
    const res = extractJobDetail(doc, {
      url: 'https://www.upwork.com/jobs/Wrapped_~0299112233/',
    });
    expect(res.ok).toBe(true);
    expect(res.detail?.client_activity).toEqual({
      interviewing: 3,
      invites_sent: 5,
      unanswered_invites: 2,
      last_viewed: '8 minutes ago',
    });
  });

  it('extracts proposals_insights_v2 job activity, skills, duration3, and air3-card-section screening questions', () => {
    const doc = parseHtmlDocument(`
      <html><body><div class="job-details-content">
        <h1><span class="flex-1">Full Stack TypeScript Engineer</span></h1>
        <div data-test="Description">
          <p class="multiline-text">Build and maintain a modern TypeScript web application.</p>
        </div>
        <ul>
          <li><div data-cy="clock-timelog"></div><strong>$60.00</strong> - <strong>$85.00</strong></li>
          <li><div data-cy="expertise"></div><strong>Expert</strong></li>
          <li><div data-cy="duration3"></div><strong><span>3 to 6 months</span></strong></li>
        </ul>
        <div data-test="proposals-insights-v2-skills-matching">
          <span data-test="proposals-insights-v2-skill-chip" class="air3-badge-skill">
            <span class="air3-line-clamp">TypeScript</span>
          </span>
          <span data-test="proposals-insights-v2-skill-chip" class="air3-badge-skill">
            <span class="air3-line-clamp">React</span>
          </span>
        </div>
        <div data-test="proposals-insights-v2-job-activity">
          <span data-test="proposals-insights-v2-education-popover">
            <span><span data-test="proposals-insights-v2-education-anchor-job-activity-title">
              <h5 class="job-activity-title-heading">Activity on this job</h5>
            </span></span>
          </span>
          <div>
            <div data-test="proposals-insights-v2-job-activity-section">
              <div><div><div>Bid range</div></div><button type="button" data-test="proposals-insights-v2-job-activity-section-toggle"></button></div>
              <div data-ev-sublocation="!collapse"><div>$50 - $80</div></div>
            </div>
            <div data-test="proposals-insights-v2-job-activity-section">
              <div><div><div>Proposals</div> <div>(1)</div></div><button type="button"></button></div>
            </div>
            <div data-test="proposals-insights-v2-job-activity-section">
              <div><div><div>Invites</div> <div>(0)</div></div><button type="button"></button></div>
            </div>
            <div data-test="proposals-insights-v2-job-activity-section">
              <div><div><div>Interviews</div> <div>(2)</div></div></div>
              <div data-ev-sublocation="!collapse"><div></div></div>
            </div>
            <div data-test="proposals-insights-v2-job-activity-section">
              <div><div><div>Offers</div> <div>(0)</div></div><button type="button"></button></div>
            </div>
            <div data-test="proposals-insights-v2-job-activity-section">
              <div><div><div>Hires</div> <div>(0)</div></div></div>
              <div data-ev-sublocation="!collapse"><div></div></div>
            </div>
            <div><span>Last viewed by client:</span> <span>12 min ago</span> <span><div class="help-icon"></div></span></div>
          </div>
        </div>
        <section class="air3-card-section">
          <ol class="list-styled">
            <li>Describe your experience with Vitest *</li>
            <li>Link a recent production TypeScript repository</li>
          </ol>
        </section>
      </div></body></html>
    `);

    const url = 'https://www.upwork.com/jobs/Full-Stack-TS_~0288776655/';
    const res = extractJobDetail(doc, {
      url,
      requireDrawer: true,
      location: { href: url, pathname: '/jobs/Full-Stack-TS_~0288776655/' },
    });

    expect(res.ok).toBe(true);
    expect(res.detail?.duration).toBe('3 to 6 months');
    expect(res.detail?.skills).toEqual(['TypeScript', 'React']);
    expect(res.detail?.proposals_tier).toBe('1');
    expect(res.detail?.proposals_count).toBe(1);
    expect(res.detail?.client_activity).toEqual({
      interviewing: 2,
      invites_sent: 0,
      last_viewed: '12 min ago',
    });
    expect(res.detail?.screening_questions).toEqual([
      { index: 0, prompt: 'Describe your experience with Vitest *', required: true },
      { index: 1, prompt: 'Link a recent production TypeScript repository', required: false },
    ]);
  });

  it('ignores button and !collapse siblings with digits in proposals_insights_v2 sections', () => {
    const doc = parseHtmlDocument(`
      <html><body><main>
        <h1>Collapsed Noise Job</h1>
        <div data-test="Description"><p class="multiline-text">Build API.</p></div>
        <div data-test="proposals-insights-v2-job-activity">
          <div data-test="proposals-insights-v2-job-activity-section">
            <div><div><div>Interviews</div></div><button type="button">2</button></div>
            <div data-ev-sublocation="!collapse"><div>1 to 5</div></div>
          </div>
          <div data-test="proposals-insights-v2-job-activity-section">
            <div><div>Invites</div></div>
            <div data-ev-sublocation="!collapse"><div>3</div></div>
          </div>
        </div>
      </main></body></html>
    `);
    const res = extractJobDetail(doc, {
      url: 'https://www.upwork.com/jobs/Noise_~0211223355/',
    });
    expect(res.ok).toBe(true);
    expect(res.detail?.client_activity).toEqual({});
  });

  it('prefers legacy li.ca-item values over proposals_insights_v2 when both are present', () => {
    const doc = parseHtmlDocument(`
      <html><body><main>
        <h1>Hybrid Activity Job</h1>
        <div data-test="Description"><p class="multiline-text">Build API.</p></div>
        <ul class="client-activity-items">
          <li class="ca-item"><span class="title">Interviewing:</span><span class="value">5</span></li>
          <li class="ca-item"><span class="title">Last viewed by client:</span><span class="value">2 minutes ago</span></li>
        </ul>
        <div data-test="proposals-insights-v2-job-activity">
          <div data-test="proposals-insights-v2-job-activity-section">
            <div><div><div>Interviews</div> <div>(1)</div></div></div>
          </div>
          <div data-test="proposals-insights-v2-job-activity-section">
            <div><div><div>Invites</div> <div>(3)</div></div></div>
          </div>
          <div><span>Last viewed by client:</span> <span>12 min ago</span></div>
        </div>
      </main></body></html>
    `);
    const res = extractJobDetail(doc, {
      url: 'https://www.upwork.com/jobs/Hybrid_~0211223344/',
    });
    expect(res.ok).toBe(true);
    expect(res.detail?.client_activity).toEqual({
      interviewing: 5,
      invites_sent: 3,
      last_viewed: '2 minutes ago',
    });
  });
});
