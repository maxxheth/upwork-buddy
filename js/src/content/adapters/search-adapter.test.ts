import { describe, expect, it } from 'vitest';
import type { PassiveSearchBatch, PassiveTapPayload } from '../../shared/protocol';
import { parseHtmlDocument } from '../selector-engine';
import {
  buildSearchUrl,
  extractJobsFromGraphQLPayloads,
  extractSearchListings,
} from './search-adapter';

const SEARCH_HTML = `
<!DOCTYPE html>
<html>
<body>
  <nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>
  <main>
    <article class="job-tile" data-test="JobTile">
      <a data-test="job-tile-title-link" href="/jobs/Go-Backend-span-class-highlight-Engineer-span_~022111887415567641941/?referrer_url_path=/nx/search/jobs/">
        Go Backend <span class="highlight">Engineer</span>
      </a>
      <div data-test="JobDescription"><p>Build Go microservices.</p></div>
      <div data-test="job-type-label"><strong>Fixed price</strong></div>
      <div data-test="experience-level"><strong>Expert</strong></div>
      <div data-test="token"><span>Go</span></div>
      <div data-test="token"><span>PostgreSQL</span></div>
      <div data-test="job-pubilshed-date"><span>Posted 1 hour ago</span></div>
      <div data-qa="client-location">Canada</div>
      <div data-test="proposals-tier">5 to 10</div>
      <div data-qa="client-rating">4.95</div>
      <strong data-test="payment-verification-status">Payment verified</strong>
      <div data-test="client-spendings"><span data-test="formatted-amount">$50K+</span></div>
    </article>
    <!-- Duplicate tile with same ~ID should be deduplicated -->
    <article class="job-tile" data-test="JobTile">
      <a data-test="job-tile-title-link" href="/jobs/Go-Backend-Engineer_~022111887415567641941/">
        Go Backend Engineer
      </a>
      <div data-test="JobDescription"><p>Duplicate.</p></div>
    </article>
  </main>
  <button data-test="next-page">Next</button>
</body>
</html>
`;

const BEST_MATCHES_HTML = `
<!DOCTYPE html>
<html>
<body>
  <nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>
  <main>
    <div data-test="job-tile-list">
      <section class="air3-card-section" data-ev-sublocation="job_feed_tile">
        <h3 class="job-tile-title"><a href="/jobs/WordPress-Sage-Developer_~022199998888777766665/">WordPress Sage Developer</a></h3>
        <span data-test="job-description-text">Build custom Sage 10 theme with ACF blocks.</span>
        <strong data-test="job-type">Hourly: $60.00 - $90.00</strong>
        <span data-test="contractor-tier">Expert</span>
        <div data-test="token-container"><span data-test="attr-item">WordPress</span><span data-test="attr-item">PHP</span></div>
        <span data-test="posted-on">Posted 30 minutes ago</span>
        <strong data-test="payment-verification-status">Payment unverified</strong>
        <strong data-test="proposals">Less than 5</strong>
      </section>
    </div>
  </main>
</body>
</html>
`;

describe('Search & Authenticated Feeds Adapter', () => {
  it('builds Upwork search URLs with exact native facets and feed endpoints', () => {
    const searchUrl = buildSearchUrl({
      source: 'search',
      query: 'golang postgresql',
      sort: 'recency',
      per_page: 50,
      contractor_tier: [2, 3],
      contract_type: 'hourly',
      budget_min: 500,
      budget_max: 2500,
      proposal_tiers: ['0-4', '5-9'],
      category: '531770282580668418',
      page: 2,
    });
    const u = new URL(searchUrl);
    expect(u.pathname).toBe('/nx/search/jobs/');
    expect(u.searchParams.get('q')).toBe('golang postgresql');
    expect(u.searchParams.get('sort')).toBe('recency');
    expect(u.searchParams.get('per_page')).toBe('50');
    expect(u.searchParams.get('contractor_tier')).toBe('2,3');
    expect(u.searchParams.get('t')).toBe('0');
    expect(u.searchParams.get('amount')).toBe('500-2500');
    expect(u.searchParams.get('proposals')).toBe('0-4,5-9');
    expect(u.searchParams.get('category2_uid')).toBe('531770282580668418');
    expect(u.searchParams.get('page')).toBe('2');

    expect(buildSearchUrl({ source: 'best_matches' })).toBe(
      'https://www.upwork.com/nx/find-work/best-matches',
    );
    expect(buildSearchUrl({ source: 'most_recent' })).toBe(
      'https://www.upwork.com/nx/find-work/most-recent',
    );
    expect(buildSearchUrl({ source: 'saved_jobs' })).toBe(
      'https://www.upwork.com/nx/find-work/saved-jobs',
    );
    expect(
      buildSearchUrl({
        search_url: 'https://www.upwork.com/nx/search/jobs/?q=saved',
        page: 3,
      }),
    ).toBe('https://www.upwork.com/nx/search/jobs/?q=saved&page=3');

    expect(() =>
      buildSearchUrl({ search_url: 'https://user:pass@www.upwork.com/nx/search/jobs/' }),
    ).toThrow(/credentials/i);
    expect(() =>
      buildSearchUrl({ search_url: 'https://user@www.upwork.com/nx/search/jobs/' }),
    ).toThrow(/credentials/i);
  });

  it('extracts search listings, normalizes Fixed price, deduplicates, and merges passive GraphQL payloads', () => {
    const doc = parseHtmlDocument(SEARCH_HTML);
    const passivePayloads: PassiveTapPayload[] = [
      {
        kind: 'graphql',
        url: 'https://www.upwork.com/api/graphql/v1',
        capturedAt: '2026-11-19T00:00:00Z',
        data: {
          jobSearch: {
            results: [
              {
                ciphertext: '~022111887415567641941',
                title: 'GraphQL Title Should Not Overwrite DOM',
                connectPrice: 12,
                totalApplicants: 7,
                client: {
                  totalHires: 22,
                  hireRate: 80,
                  totalReviews: 19,
                },
              },
            ],
          },
        },
      },
    ];

    const res = extractSearchListings(doc, {
      source: 'search',
      query: 'golang',
      passivePayloads,
      location: {
        href: 'https://www.upwork.com/nx/search/jobs/?q=golang',
        pathname: '/nx/search/jobs/',
      },
    });

    expect(res.ok).toBe(true);
    expect(res.hasNextPage).toBe(true);
    expect(res.jobs).toHaveLength(1);
    const job = res.jobs[0];
    expect(job.job_title).toBe('Go Backend Engineer');
    expect(job.upwork_job_id).toBe('~022111887415567641941');
    expect(job.contract_type).toBe('fixed');
    expect(job.budget).toBe('Fixed price');
    expect(job.budget_amount).toBe('');
    expect(job.payment_verified).toBe(true);
    expect(job.client_spent_usd).toBe(50000);
    expect(job.connects_required).toBe(12);
    expect(job.client_hires).toBe(22);
    expect(job.client_hire_rate).toBe(80);
    expect(job.client_reviews).toBe(19);
    expect(job.source_query).toBe('golang');
  });

  it('extracts authenticated feeds (best_matches) and halts immediately on HUMAN_ACTION_REQUIRED', () => {
    const feedDoc = parseHtmlDocument(BEST_MATCHES_HTML);
    const feedRes = extractSearchListings(feedDoc, {
      source: 'best_matches',
      location: {
        href: 'https://www.upwork.com/nx/find-work/best-matches',
        pathname: '/nx/find-work/best-matches',
      },
    });
    expect(feedRes.ok).toBe(true);
    expect(feedRes.jobs).toHaveLength(1);
    expect(feedRes.jobs[0].contract_type).toBe('hourly');
    expect(feedRes.jobs[0].rate_range).toBe('$60.00 - $90.00');
    expect(feedRes.jobs[0].payment_verified).toBe(false);
    expect(feedRes.jobs[0].proposals_count).toBe(4);

    const challengeDoc = parseHtmlDocument(
      '<html><body><div id="cf-challenge-running">Checking your browser</div></body></html>',
    );
    const challengeRes = extractSearchListings(challengeDoc, {
      source: 'search',
      location: { href: 'https://www.upwork.com/nx/search/jobs/', pathname: '/nx/search/jobs/' },
    });
    expect(challengeRes.ok).toBe(false);
    expect(challengeRes.errorCode).toBe('HUMAN_ACTION_REQUIRED');
  });

  it('handles circular GraphQL objects safely without infinite recursion', () => {
    const cyclic: Record<string, unknown> = { ciphertext: '~0111222333444555', title: 'Safe Job' };
    cyclic.self = cyclic;
    const map = extractJobsFromGraphQLPayloads([
      {
        kind: 'graphql',
        url: 'https://www.upwork.com/api/graphql/v1',
        capturedAt: '2026-11-19T00:00:00Z',
        data: cyclic,
      },
    ]);
    expect(map.get('~0111222333444555')?.job_title).toBe('Safe Job');
  });

  it('extracts [data-qa="client-spend"] and leaves budget_amount empty for label-only Fixed price cards', () => {
    const html = `
      <!DOCTYPE html>
      <html><body><main>
        <article class="job-tile" data-test="JobTile">
          <a data-test="job-tile-title-link" href="/jobs/Label-Only-Fixed_~030100000000000000001/">Label Only Fixed</a>
          <div data-test="JobDescription"><p>Desc</p></div>
          <li data-test="job-type-label"><strong>Fixed price</strong></li>
          <span data-qa="client-spend">10k total spent</span>
        </article>
      </main></body></html>
    `;
    const res = extractSearchListings(parseHtmlDocument(html), {
      source: 'search',
      query: 'boundary_cases',
      location: {
        href: 'https://www.upwork.com/nx/search/jobs/?q=boundary_cases',
        pathname: '/nx/search/jobs/',
      },
    });
    expect(res.ok).toBe(true);
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].contract_type).toBe('fixed');
    expect(res.jobs[0].budget).toBe('Fixed price');
    expect(res.jobs[0].budget_amount).toBe('');
    expect(res.jobs[0].rate_range ?? '').toBe('');
    expect(res.jobs[0].client_spent_usd).toBe(10000);
  });

  it('merges nested jobTile.job connects_required, client.totalSpent.amount, and client_hire_rate from GraphQL payloads', () => {
    const html = `
      <!DOCTYPE html>
      <html><body><main>
        <article class="job-tile" data-test="JobTile">
          <a data-test="job-tile-title-link" href="/jobs/On-Page-SEO-Expert_~022115332344639171/">On-Page SEO Expert Needed</a>
          <div data-test="JobDescription"><p>Audit site speed and schema.</p></div>
          <div data-test="job-type-label"><strong>Fixed price</strong></div>
        </article>
      </main></body></html>
    `;
    const passivePayloads: PassiveTapPayload[] = [
      {
        kind: 'graphql',
        url: 'https://www.upwork.com/api/graphql?alias=searchJobPostings',
        operationName: 'searchJobPostings',
        capturedAt: '2026-11-20T08:00:00Z',
        data: {
          data: {
            search: {
              universalSearchNuxt: {
                userJobSearchV1: {
                  results: [
                    {
                      id: '022115332344639171',
                      ciphertext: '~022115332344639171',
                      title: 'On-Page SEO Expert Needed',
                      jobTile: {
                        job: {
                          ciphertext: '~022115332344639171',
                          jobType: 'FIXED',
                          fixedPriceAmount: { amount: 1500.0 },
                          connectPrice: 12,
                          connects_required: 12,
                          proposalsTier: 'Less than 5',
                        },
                      },
                      client: {
                        totalSpent: { amount: 120000 },
                        totalHires: 52,
                        client_hire_rate: 85,
                        paymentVerificationStatus: 'VERIFIED',
                        location: { country: 'United States' },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ];

    const res = extractSearchListings(parseHtmlDocument(html), {
      source: 'search',
      query: 'seo',
      passivePayloads,
      location: {
        href: 'https://www.upwork.com/nx/search/jobs/?q=seo',
        pathname: '/nx/search/jobs/',
      },
    });
    expect(res.ok).toBe(true);
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0].connects_required).toBe(12);
    expect(res.jobs[0].client_hire_rate).toBe(85);
    expect(res.jobs[0].client_spent_usd).toBe(120000);
    expect(res.jobs[0].payment_verified).toBe(true);
    expect(res.jobs[0].proposals_tier).toBe('Less than 5');
  });

  it('encodes hourly_rate and payment_verified query facets cleanly and rejects invalid bounds', () => {
    const bothUrl = new URL(
      buildSearchUrl({
        source: 'search',
        query: 'go',
        hourly_rate_min: 70,
        hourly_rate_max: 130,
        payment_verified_only: true,
      }),
    );
    expect(bothUrl.searchParams.get('hourly_rate')).toBe('70-130');
    expect(bothUrl.searchParams.get('payment_verified')).toBe('1');

    const minOnlyUrl = new URL(
      buildSearchUrl({
        source: 'search',
        query: 'go',
        hourly_rate_min: 72.5,
      }),
    );
    expect(minOnlyUrl.searchParams.get('hourly_rate')).toBe('72.5-');
    expect(minOnlyUrl.searchParams.has('payment_verified')).toBe(false);

    const maxOnlyUrl = new URL(
      buildSearchUrl({
        source: 'search',
        query: 'go',
        hourly_rate_max: 130,
        payment_verified_only: false,
      }),
    );
    expect(maxOnlyUrl.searchParams.get('hourly_rate')).toBe('-130');
    expect(maxOnlyUrl.searchParams.has('payment_verified')).toBe(false);

    const zeroMinUrl = new URL(buildSearchUrl({ source: 'search', hourly_rate_min: 0 }));
    expect(zeroMinUrl.searchParams.get('hourly_rate')).toBe('0-');

    const zeroMaxUrl = new URL(buildSearchUrl({ source: 'search', hourly_rate_max: 0 }));
    expect(zeroMaxUrl.searchParams.get('hourly_rate')).toBe('-0');

    const zeroBothUrl = new URL(
      buildSearchUrl({ source: 'search', hourly_rate_min: 0, hourly_rate_max: 0 }),
    );
    expect(zeroBothUrl.searchParams.get('hourly_rate')).toBe('0-0');

    expect(() => buildSearchUrl({ hourly_rate_min: -1 })).toThrow(/non-negative/i);
    expect(() => buildSearchUrl({ hourly_rate_max: -5 })).toThrow(/non-negative/i);
    expect(() => buildSearchUrl({ hourly_rate_min: Number.NaN })).toThrow(/finite/i);
    expect(() => buildSearchUrl({ hourly_rate_max: Number.POSITIVE_INFINITY })).toThrow(/finite/i);
    expect(() => buildSearchUrl({ hourly_rate_min: 150, hourly_rate_max: 80 })).toThrow(/exceed/i);
  });

  it('extracts payment_verified from [data-qa="payment-verified"] and [data-test="payment-verified"] and returns undefined when absent', () => {
    const html = `
      <!DOCTYPE html>
      <html><body><main>
        <article class="job-tile" data-test="JobTile">
          <a data-test="job-tile-title-link" href="/jobs/QA-Verified_~022115332344639180/">QA Verified</a>
          <div data-test="JobDescription"><p>Desc 1</p></div>
          <span data-qa="payment-verified">Payment Verified</span>
        </article>
        <article class="job-tile" data-test="JobTile">
          <a data-test="job-tile-title-link" href="/jobs/Test-Verified_~022115332344639181/">Test Verified</a>
          <div data-test="JobDescription"><p>Desc 2</p></div>
          <span data-test="payment-verified">Payment verified</span>
        </article>
        <article class="job-tile" data-test="JobTile">
          <a data-test="job-tile-title-link" href="/jobs/Missing-Verified_~022115332344639182/">Missing Verified</a>
          <div data-test="JobDescription"><p>Desc 3</p></div>
        </article>
      </main></body></html>
    `;
    const res = extractSearchListings(parseHtmlDocument(html), {
      source: 'search',
      query: 'wordpress',
      location: {
        href: 'https://www.upwork.com/nx/search/jobs/?q=wordpress',
        pathname: '/nx/search/jobs/',
      },
    });
    expect(res.ok).toBe(true);
    expect(res.jobs).toHaveLength(3);
    expect(res.jobs[0].payment_verified).toBe(true);
    expect(res.jobs[1].payment_verified).toBe(true);
    expect(res.jobs[2].payment_verified).toBeUndefined();
  });

  it('extracts GraphQL-only listings with 0 DOM containers, orders chunks, skips titleless patches, and honors apiPagination.hasNextPage', () => {
    const driftedDom = parseHtmlDocument(`
      <!DOCTYPE html>
      <html><body>
        <nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>
        <main><div class="drifted-shell">Loading skeleton only</div></main>
        <button data-test="next-page">Next</button>
      </body></html>
    `);

    const searchBatches: PassiveSearchBatch[] = [
      {
        captureSeq: 2,
        navigationEpoch: 1,
        captureKind: 'graphql',
        requestUrl: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=golang',
        operationName: 'userJobSearchV1',
        sourceFeed: 'search',
        query: 'golang',
        chunkIndex: 1,
        chunkCount: 2,
        capturedAt: '2026-11-22T10:00:02.000Z',
        paging: {
          totalCount: 22,
          offset: 20,
          count: 2,
          page: 2,
          perPage: 20,
          hasNextPage: false,
        },
        jobs: [
          {
            upwork_job_id: '~029900000000000002',
            job_title: 'Senior Rust & Go Engineer',
            job_description: 'Build distributed services.',
            contract_type: 'hourly',
            rate_min: '$75',
            rate_max: '$110',
            rate_range: '$75 - $110',
            budget: '$75 - $110/hr',
            experience_level: 'Expert',
            duration: '3 to 6 months',
            hours_per_week: '30+ hrs/week',
            posted_at_est: '2026-11-22T09:30:00.000Z',
            connects_required: 16,
          },
          {
            // Metadata-only patch without job_title must be skipped in GraphQL-only append
            upwork_job_id: '~029900000000000099',
            connects_required: 8,
          },
        ],
      },
      {
        captureSeq: 1,
        navigationEpoch: 1,
        captureKind: 'graphql',
        requestUrl: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=golang',
        operationName: 'userJobSearchV1',
        sourceFeed: 'search',
        query: 'golang',
        chunkIndex: 0,
        chunkCount: 2,
        capturedAt: '2026-11-22T10:00:01.000Z',
        paging: {
          totalCount: 22,
          offset: 0,
          count: 20,
          page: 1,
          perPage: 20,
          hasNextPage: true,
          nextCursor: 'cursor-page-2',
        },
        jobs: [
          {
            upwork_job_id: '~029900000000000001',
            job_title: 'Go Microservices Architect',
            job_description: 'Design event-driven Go services.',
            contract_type: 'fixed',
            budget_amount: '$2,500',
            budget: '$2,500 fixed',
            posted_at_est: '2026-11-22T09:00:00.000Z',
            connects_required: 12,
            client_hire_rate: 90,
            payment_verified: true,
          },
        ],
      },
      {
        // Auth error-only batch must be skipped without overriding pagination
        captureSeq: 3,
        navigationEpoch: 1,
        captureKind: 'graphql',
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=golang',
        sourceFeed: 'search',
        graphqlErrorCodes: ['RATE_LIMITED'],
        capturedAt: '2026-11-22T10:00:03.000Z',
        paging: { hasNextPage: true },
        jobs: [],
      },
    ];

    const res = extractSearchListings(driftedDom, {
      source: 'search',
      query: 'golang',
      searchBatches,
      location: {
        href: 'https://www.upwork.com/nx/search/jobs/?q=golang',
        pathname: '/nx/search/jobs/',
      },
    });

    expect(res.ok).toBe(true);
    expect(res.extractionSource).toBe('graphql');
    expect(res.hasNextPage).toBe(false);
    expect(res.apiPagination).toEqual({
      totalCount: 22,
      offset: 20,
      count: 2,
      page: 2,
      perPage: 20,
      hasNextPage: false,
    });
    expect(res.jobs).toHaveLength(2);

    expect(res.jobs[0]).toMatchObject({
      upwork_job_id: '~029900000000000001',
      job_title: 'Go Microservices Architect',
      source: 'chrome_extension_graphql',
      source_feed: 'search',
      source_query: 'golang',
      status: 'ready',
      canonical_url: 'https://www.upwork.com/jobs/~029900000000000001/',
      contract_type: 'fixed',
      budget_amount: '$2,500',
      budget: '$2,500 fixed',
      posted_at_est: '2026-11-22T09:00:00.000Z',
      connects_required: 12,
      client_hire_rate: 90,
      payment_verified: true,
    });
    expect(res.jobs[1]).toMatchObject({
      upwork_job_id: '~029900000000000002',
      job_title: 'Senior Rust & Go Engineer',
      source: 'chrome_extension_graphql',
      contract_type: 'hourly',
      rate_min: '$75',
      rate_max: '$110',
      rate_range: '$75 - $110',
      budget: '$75 - $110/hr',
      experience_level: 'Expert',
      duration: '3 to 6 months',
      hours_per_week: '30+ hrs/week',
      connects_required: 16,
    });
  });

  it('merges DOM + GraphQL in hybrid mode without duplicating, preserves DOM title, enriches budget/timing, and appends GraphQL-only jobs', () => {
    const partialDom = parseHtmlDocument(`
      <!DOCTYPE html>
      <html><body>
        <nav class="air3-nav-freelancer"><span data-test="nav-user-menu">Me</span></nav>
        <main>
          <article class="job-tile" data-test="JobTile">
            <a data-test="job-tile-title-link" href="/jobs/DOM-Fixed-Job_~028811111111111111/">DOM Title Must Stay</a>
            <div data-test="JobDescription"><p>Short.</p></div>
            <div data-test="job-type-label"><strong>Fixed price</strong></div>
          </article>
        </main>
      </body></html>
    `);

    const searchBatches: PassiveSearchBatch[] = [
      {
        captureSeq: 1,
        navigationEpoch: 1,
        captureKind: 'graphql',
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=typescript',
        sourceFeed: 'search',
        query: 'typescript',
        capturedAt: '2026-11-22T10:05:00.000Z',
        paging: { hasNextPage: true, page: 1, totalCount: 30 },
        jobs: [
          {
            upwork_job_id: '~028811111111111111',
            job_title: 'GraphQL Title Must Not Overwrite DOM',
            job_description: 'Full detailed TypeScript architecture specification from GraphQL.',
            contract_type: 'fixed',
            budget_amount: '$1,500',
            budget: '$1,500 fixed',
            posted_at_est: '2026-11-22T09:45:00.000Z',
            connects_required: 10,
            experience_level: 'Intermediate',
          },
          {
            upwork_job_id: '~028822222222222222',
            job_title: 'Virtualized GraphQL-Only Job',
            job_description: 'Only present in GraphQL payload.',
            contract_type: 'hourly',
            rate_min: '$55',
            rate_max: '$85',
            rate_range: '$55 - $85',
            budget: '$55 - $85/hr',
            connects_required: 6,
          },
        ],
      },
    ];

    const res = extractSearchListings(partialDom, {
      source: 'search',
      query: 'typescript',
      searchBatches,
      location: {
        href: 'https://www.upwork.com/nx/search/jobs/?q=typescript',
        pathname: '/nx/search/jobs/',
      },
    });

    expect(res.ok).toBe(true);
    expect(res.extractionSource).toBe('hybrid');
    expect(res.hasNextPage).toBe(true);
    expect(res.jobs).toHaveLength(2);

    expect(res.jobs[0]).toMatchObject({
      upwork_job_id: '~028811111111111111',
      job_title: 'DOM Title Must Stay',
      source: 'chrome_extension_search',
      job_description: 'Full detailed TypeScript architecture specification from GraphQL.',
      budget_amount: '$1,500',
      budget: '$1,500 fixed',
      posted_at_est: '2026-11-22T09:45:00.000Z',
      connects_required: 10,
      experience_level: 'Intermediate',
    });
    expect(res.jobs[1]).toMatchObject({
      upwork_job_id: '~028822222222222222',
      job_title: 'Virtualized GraphQL-Only Job',
      source: 'chrome_extension_graphql',
      contract_type: 'hourly',
      budget: '$55 - $85/hr',
    });
  });

  it('enforces HUMAN_ACTION_REQUIRED challenge precedence even when populated searchBatches are provided', () => {
    const challengeDoc = parseHtmlDocument(
      '<html><body><div id="cf-challenge-running">Checking your browser</div></body></html>',
    );
    const searchBatches: PassiveSearchBatch[] = [
      {
        captureSeq: 1,
        navigationEpoch: 1,
        captureKind: 'graphql',
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
        sourceFeed: 'search',
        capturedAt: '2026-11-22T10:10:00.000Z',
        jobs: [{ upwork_job_id: '~027700000000000001', job_title: 'Leaked Job' }],
      },
    ];

    const res = extractSearchListings(challengeDoc, {
      source: 'search',
      searchBatches,
      location: { href: 'https://www.upwork.com/nx/search/jobs/', pathname: '/nx/search/jobs/' },
    });

    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('HUMAN_ACTION_REQUIRED');
    expect(res.jobs).toEqual([]);
  });

  it('falls back to dom extractionSource without GraphQL and extracts numeric strings, posted_at_est, and depth > 8 in extractJobsFromGraphQLPayloads', () => {
    const domOnlyRes = extractSearchListings(parseHtmlDocument(BEST_MATCHES_HTML), {
      source: 'best_matches',
      location: {
        href: 'https://www.upwork.com/nx/find-work/best-matches',
        pathname: '/nx/find-work/best-matches',
      },
    });
    expect(domOnlyRes.ok).toBe(true);
    expect(domOnlyRes.extractionSource).toBe('dom');

    const map = extractJobsFromGraphQLPayloads([
      {
        kind: 'graphql',
        url: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
        operationName: 'userJobSearchV1',
        capturedAt: '2026-11-22T10:15:00.000Z',
        data: {
          data: {
            level1: {
              level2: {
                level3: {
                  level4: {
                    level5: {
                      level6: {
                        level7: {
                          level8: {
                            level9: {
                              results: [
                                {
                                  ciphertext: '~026600000000000001',
                                  title: 'Deep Nested Numeric String Job',
                                  publishedOn: '2026-11-22T08:15:00Z',
                                  jobTile: {
                                    job: {
                                      ciphertext: '~026600000000000001',
                                      jobType: 'FIXED',
                                      fixedPriceAmount: '1500.00',
                                      connectPrice: 14,
                                    },
                                  },
                                },
                              ],
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    ]);

    const extracted = map.get('~026600000000000001');
    expect(extracted).toBeDefined();
    expect(extracted?.job_title).toBe('Deep Nested Numeric String Job');
    expect(extracted?.contract_type).toBe('fixed');
    expect(extracted?.budget_amount).toBe('$1,500');
    expect(extracted?.budget).toBe('$1,500 fixed');
    expect(extracted?.posted_at_est).toBe('2026-11-22T08:15:00.000Z');
    expect(extracted?.connects_required).toBe(14);
  });

  it('upgrades label-only Hourly DOM cards from GraphQL while preserving real DOM hourly dollar figures', () => {
    const html = `
      <!DOCTYPE html>
      <html><body><main>
        <article class="job-tile" data-test="JobTile">
          <a data-test="job-tile-title-link" href="/jobs/Label-Only-Hourly_~025500000000000001/">Label Only Hourly Job</a>
          <div data-test="JobDescription"><p>Need Go engineer.</p></div>
          <div data-test="job-type-label"><strong>Hourly</strong></div>
        </article>
        <article class="job-tile" data-test="JobTile">
          <a data-test="job-tile-title-link" href="/jobs/Priced-Hourly_~025500000000000002/">Priced Hourly Job</a>
          <div data-test="JobDescription"><p>Need Rust engineer.</p></div>
          <strong data-test="job-type">Hourly: $40.00 - $65.00</strong>
        </article>
      </main></body></html>
    `;

    const searchBatches: PassiveSearchBatch[] = [
      {
        captureSeq: 1,
        navigationEpoch: 1,
        captureKind: 'graphql',
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=hourly',
        sourceFeed: 'search',
        capturedAt: '2026-11-22T11:00:00.000Z',
        jobs: [
          {
            upwork_job_id: '~025500000000000001',
            job_title: 'Label Only Hourly Job',
            contract_type: 'hourly',
            rate_min: '$60',
            rate_max: '$90',
            rate_range: '$60 - $90',
            budget: '$60 - $90/hr',
          },
          {
            upwork_job_id: '~025500000000000002',
            job_title: 'Priced Hourly Job',
            contract_type: 'hourly',
            rate_min: '$50',
            rate_max: '$80',
            rate_range: '$50 - $80',
            budget: '$50 - $80/hr',
          },
        ],
      },
    ];

    const res = extractSearchListings(parseHtmlDocument(html), {
      source: 'search',
      query: 'hourly',
      searchBatches,
      location: {
        href: 'https://www.upwork.com/nx/search/jobs/?q=hourly',
        pathname: '/nx/search/jobs/',
      },
    });

    expect(res.ok).toBe(true);
    expect(res.jobs).toHaveLength(2);
    expect(res.jobs[0]).toMatchObject({
      upwork_job_id: '~025500000000000001',
      contract_type: 'hourly',
      rate_min: '$60',
      rate_max: '$90',
      rate_range: '$60 - $90',
      budget: '$60 - $90/hr',
    });
    expect(res.jobs[1]).toMatchObject({
      upwork_job_id: '~025500000000000002',
      contract_type: 'hourly',
      rate_min: '$40.00',
      rate_max: '$65.00',
      rate_range: '$40.00 - $65.00',
      budget: '$40.00 - $65.00/hr',
    });
  });
});
