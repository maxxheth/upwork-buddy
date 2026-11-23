import { describe, expect, it } from 'vitest';
import {
  chunkSearchBatch,
  detectGraphQLErrorCodes,
  extractSearchProjection,
  extractSearchRequestContext,
  inferSourceFeed,
  isKnownSearchOperation,
  KNOWN_SEARCH_OPERATIONS,
} from './graphql-search-parser';
import type { PassiveSearchBatch, ProjectedGraphQLJob } from './passive-tap-types';

function makeBatch(jobs: ProjectedGraphQLJob[]): PassiveSearchBatch {
  return {
    captureSeq: 1,
    navigationEpoch: 1,
    captureKind: 'graphql',
    requestUrl: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
    pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=golang',
    operationName: 'userJobSearchV1',
    sourceFeed: 'search',
    query: 'golang',
    jobs,
    paging: { totalCount: jobs.length, offset: 0, count: jobs.length, page: 1, perPage: 20 },
    capturedAt: '2026-11-22T23:00:00.000Z',
  };
}

describe('graphql-search-parser', () => {
  it('recognizes all KNOWN_SEARCH_OPERATIONS case-insensitively and rejects unrelated operations', () => {
    expect(KNOWN_SEARCH_OPERATIONS).toHaveLength(11);
    for (const op of KNOWN_SEARCH_OPERATIONS) {
      expect(isKnownSearchOperation(op)).toBe(true);
      expect(isKnownSearchOperation(`Upwork_${op.toUpperCase()}_V1`)).toBe(true);
    }
    expect(isKnownSearchOperation('featureFlags')).toBe(false);
    expect(isKnownSearchOperation('unreadCount')).toBe(false);
    expect(isKnownSearchOperation('')).toBe(false);
    expect(isKnownSearchOperation(undefined)).toBe(false);
  });

  it('infers sourceFeed with operationName taking precedence over pageUrl', () => {
    expect(
      inferSourceFeed('bestMatchJobsFeed', 'https://www.upwork.com/nx/search/jobs/?q=go'),
    ).toBe('best_matches');
    expect(
      inferSourceFeed('mostRecentJobsFeed', 'https://www.upwork.com/nx/find-work/best-matches'),
    ).toBe('most_recent');
    expect(inferSourceFeed('savedJobPostings', 'https://www.upwork.com/nx/search/jobs/')).toBe(
      'saved_jobs',
    );
    expect(
      inferSourceFeed('userJobSearchV1', 'https://www.upwork.com/nx/find-work/best-matches'),
    ).toBe('best_matches');
    expect(inferSourceFeed(undefined, 'https://www.upwork.com/nx/find-work/most-recent')).toBe(
      'most_recent',
    );
    expect(inferSourceFeed(undefined, 'https://www.upwork.com/nx/find-work/saved-jobs')).toBe(
      'saved_jobs',
    );
    expect(inferSourceFeed('userJobSearchV1', 'https://www.upwork.com/nx/search/jobs/')).toBe(
      'search',
    );
  });

  it('extracts context from single bodies, marketPlaceJobFilter, Apollo batches, and URL fallbacks', () => {
    const singleCtx = extractSearchRequestContext(
      'https://www.upwork.com/api/graphql/v1',
      JSON.stringify({
        operationName: 'userJobSearchV1',
        variables: {
          requestVariables: {
            userQuery: 'golang',
            paging: { offset: 50, count: 50 },
          },
        },
      }),
      'https://www.upwork.com/nx/search/jobs/?q=ignored',
    );
    expect(singleCtx.isSearchRequest).toBe(true);
    expect(singleCtx.operationName).toBe('userJobSearchV1');
    expect(singleCtx.query).toBe('golang');
    expect(singleCtx.requestedPaging).toEqual({
      offset: 50,
      count: 50,
      page: 2,
      perPage: 50,
    });

    const filterCtx = extractSearchRequestContext(
      'https://www.upwork.com/api/graphql/v1',
      JSON.stringify({
        operationName: 'marketplaceJobPostingsSearch',
        variables: {
          marketPlaceJobFilter: { searchTerm_eq: 'rust wasm' },
          pagination: { first: 25, page: 3 },
        },
      }),
    );
    expect(filterCtx.isSearchRequest).toBe(true);
    expect(filterCtx.query).toBe('rust wasm');
    expect(filterCtx.requestedPaging).toEqual({ count: 25, page: 3, perPage: 25 });

    const batchCtx = extractSearchRequestContext(
      'https://www.upwork.com/api/graphql/v1',
      JSON.stringify([
        { operationName: 'featureFlags', variables: {} },
        {
          operationName: 'userJobSearchV1',
          variables: {
            requestVariables: { userQuery: 'typescript', paging: { offset: 0, count: 20 } },
          },
        },
      ]),
    );
    expect(batchCtx.isSearchRequest).toBe(true);
    expect(batchCtx.operationNames).toEqual(['featureFlags', 'userJobSearchV1']);
    expect(batchCtx.operationName).toBe('userJobSearchV1');
    expect(batchCtx.query).toBe('typescript');
    expect(batchCtx.items).toHaveLength(2);

    const malformedCtx = extractSearchRequestContext(
      'https://www.upwork.com/api/graphql/v1?alias=searchJobPostings&q=python',
      '{not-valid-json',
      'https://www.upwork.com/nx/search/jobs/?q=fallback&page=2&per_page=10',
    );
    expect(malformedCtx.isSearchRequest).toBe(true);
    expect(malformedCtx.operationName).toBe('searchJobPostings');
    expect(malformedCtx.query).toBe('fallback');
    expect(malformedCtx.requestedPaging).toEqual({ page: 2, perPage: 10 });
  });

  it('extracts universalSearchNuxt.userJobSearchV1 fast-path including depth > 8 jobTile.job without inner ciphertext', () => {
    const payload = {
      data: {
        data: {
          search: {
            universalSearchNuxt: {
              userJobSearchV1: {
                paging: { total: 45, offset: 20, count: 20 },
                results: [
                  {
                    id: '022115332344639171',
                    ciphertext: '~022115332344639171',
                    title: 'Senior Go Engineer',
                    description: 'Build reliable distributed systems.',
                    url: '/jobs/Senior-Go-Engineer_~022115332344639171/?referrer=search',
                    publishedOn: '2026-11-22T20:15:00Z',
                    jobTile: {
                      job: {
                        jobType: 'FIXED',
                        fixedPriceAmount: { rawValue: '1500.00' },
                        contractorTier: 3,
                        fixedPriceEngagementDuration: { label: '1 to 3 months' },
                        connectPrice: 16,
                        proposalsTier: '0_4',
                      },
                    },
                    ontologySkills: [{ prettyName: 'Go' }, { prettyName: 'PostgreSQL' }],
                    skills: [{ name: 'go' }, { prettyName: 'Docker' }],
                    client: {
                      totalSpent: '$50K+',
                      paymentVerificationStatus: 'VERIFIED',
                      totalFeedback: 4.95,
                      totalReviews: 18,
                      totalHires: 24,
                      hireRate: 88,
                      location: { country: 'United States' },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };

    const res = extractSearchProjection(payload, {
      requestUrl: 'https://www.upwork.com/api/graphql/v1',
      pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=go',
      operationName: 'userJobSearchV1',
    });

    expect(res.matched).toBe(true);
    expect(res.isExplicitEmpty).toBe(false);
    expect(res.paging).toEqual({
      totalCount: 45,
      offset: 20,
      count: 20,
      page: 2,
      perPage: 20,
      hasNextPage: true,
    });
    expect(res.jobs).toHaveLength(1);
    expect(res.jobs[0]).toEqual({
      upwork_job_id: '~022115332344639171',
      job_title: 'Senior Go Engineer',
      job_description: 'Build reliable distributed systems.',
      canonical_url: 'https://www.upwork.com/jobs/~022115332344639171/',
      url: 'https://www.upwork.com/jobs/Senior-Go-Engineer_~022115332344639171/',
      contract_type: 'fixed',
      budget_amount: '$1,500',
      budget: '$1,500 fixed',
      experience_level: 'Expert',
      duration: '1 to 3 months',
      skills: 'Go, PostgreSQL, Docker',
      posted_at_est: '2026-11-22T20:15:00.000Z',
      proposals_tier: 'Less than 5',
      proposals_count: 4,
      connects_required: 16,
      client_spent_usd: 50000,
      client_spent: '$50,000',
      payment_verified: true,
      client_rating: 4.95,
      client_reviews: 18,
      client_hires: 24,
      client_hire_rate: 88,
      client_country: 'United States',
    });
  });

  it('handles marketplaceJobPostingsSearch Relay edges, feed envelopes, and __projected passthrough', () => {
    const relayRes = extractSearchProjection(
      {
        data: {
          marketplaceJobPostingsSearch: {
            totalCount: 120,
            pageInfo: { hasNextPage: false, endCursor: 'cursor-120' },
            edges: [
              {
                node: {
                  ciphertext: '~021111111111111111',
                  title: 'Hourly React Architect',
                  jobType: 'HOURLY',
                  hourlyBudgetMin: '60',
                  hourlyBudgetMax: { rawValue: '90.50' },
                  contractorTier: 'INTERMEDIATE',
                  hourlyEngagementDuration: { label: 'More than 6 months' },
                  engagement: '30+ hrs/week',
                  proposalsTier: '20_49',
                  totalApplicants: 31,
                  connectsRequired: 10,
                  buyer: {
                    isPaymentVerified: false,
                    totalSpent: { amount: 0 },
                  },
                },
              },
            ],
          },
        },
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
      },
    );

    expect(relayRes.matched).toBe(true);
    expect(relayRes.paging).toEqual({
      totalCount: 120,
      hasNextPage: false,
      nextCursor: 'cursor-120',
    });
    expect(relayRes.jobs[0]).toMatchObject({
      upwork_job_id: '~021111111111111111',
      contract_type: 'hourly',
      rate_min: '$60',
      rate_max: '$90.50',
      rate_range: '$60 - $90.50',
      budget: '$60 - $90.50/hr',
      experience_level: 'Intermediate',
      duration: 'More than 6 months',
      hours_per_week: '30+ hrs/week',
      proposals_tier: '20 to 50',
      proposals_count: 31,
      connects_required: 10,
      payment_verified: false,
      client_spent_usd: 0,
      client_spent: '$0',
    });

    for (const key of [
      'bestMatchJobsFeed',
      'mostRecentJobsFeed',
      'savedJobs',
      'savedJobPostings',
      'jobSearch',
    ]) {
      const feedRes = extractSearchProjection(
        {
          data: {
            [key]: {
              results: [
                {
                  ciphertext: '~029999999999999999',
                  title: `Feed ${key}`,
                  jobType: 'FIXED',
                  fixedPriceAmount: { amount: 0 },
                },
              ],
            },
          },
        },
        {
          requestUrl: 'https://www.upwork.com/api/graphql/v1',
          pageUrl: 'https://www.upwork.com/nx/find-work/best-matches',
        },
      );
      expect(feedRes.matched).toBe(true);
      expect(feedRes.jobs[0].budget).toBe('Fixed price');
      expect(feedRes.jobs[0].budget_amount).toBe('');
    }

    const projectedPassthrough = extractSearchProjection(
      {
        __projected: true,
        jobs: [
          {
            upwork_job_id: '~028888888888888888',
            job_title: 'Pre-projected Job',
            contract_type: 'fixed',
            budget_amount: '$2,000',
            budget: '$2,000 fixed',
          },
        ],
        paging: { totalCount: 1, page: 1, perPage: 20, hasNextPage: false },
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
      },
    );
    expect(projectedPassthrough.matched).toBe(true);
    expect(projectedPassthrough.jobs[0].job_title).toBe('Pre-projected Job');
    expect(projectedPassthrough.paging?.hasNextPage).toBe(false);
  });

  it('normalizes timestamps, proposal tiers, single-bound hourly rates, and caps long descriptions', () => {
    const longDesc = 'A'.repeat(20_000);
    const res = extractSearchProjection(
      {
        data: {
          jobSearch: {
            results: [
              {
                ciphertext: '~023333333333333333',
                title: 'Single Bound Hourly',
                description: longDesc,
                jobType: 'HOURLY',
                hourlyBudgetMin: 75,
                contractorTier: 1,
                publishedOn: 'not-a-date',
                posted_text: '2026-11-22T10:00:00Z',
                proposalsTier: '50_PLUS',
                client: { paymentVerificationStatus: 'UNVERIFIED' },
              },
              {
                ciphertext: '~024444444444444444',
                title: 'Relative Text Preserved',
                jobType: 'HOURLY',
                hourlyBudgetMax: 120,
                contractorTier: 'ENTRY_LEVEL',
                publishedDateTime: '12345',
                posted_text: 'Posted 12 minutes ago',
                proposalsTier: '10_14',
                client: { paymentVerificationStatus: 1 },
              },
            ],
          },
        },
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
      },
    );

    expect(res.jobs[0].job_description?.length).toBe(16_384);
    expect(res.jobs[0].rate_range).toBe('$75+');
    expect(res.jobs[0].budget).toBe('$75+/hr');
    expect(res.jobs[0].experience_level).toBe('Entry level');
    expect(res.jobs[0].posted_at_est).toBeUndefined();
    expect(res.jobs[0].posted_text).toBeUndefined();
    expect(res.jobs[0].proposals_tier).toBe('50+');
    expect(res.jobs[0].proposals_count).toBe(999);
    expect(res.jobs[0].payment_verified).toBe(false);

    expect(res.jobs[1].rate_range).toBe('Up to $120');
    expect(res.jobs[1].budget).toBe('Up to $120/hr');
    expect(res.jobs[1].posted_at_est).toBeUndefined();
    expect(res.jobs[1].posted_text).toBe('Posted 12 minutes ago');
    expect(res.jobs[1].proposals_tier).toBe('10 to 15');
    expect(res.jobs[1].proposals_count).toBe(15);
    expect(res.jobs[1].payment_verified).toBe(true);
  });

  it('rejects non-job id nodes, handles depth 14 vs >14, cycles, and 15k node ceiling', () => {
    // Non-job objects with id/uid must NOT be extracted.
    const nonJobRes = extractSearchProjection(
      {
        data: {
          ontologySkills: [{ id: '1234567890', name: 'TypeScript', prettyName: 'TypeScript' }],
          categories: [{ uid: '9876543210', title: 'Web Development' }],
          users: [{ id: '5555555555', client: { totalHires: 4 }, title: 'User Profile' }],
        },
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
      },
    );
    expect(nonJobRes.matched).toBe(false);
    expect(nonJobRes.jobs).toEqual([]);

    // Depth 14 succeeds; depth 15 is ignored.
    const makeNested = (depth: number, id: string): Record<string, unknown> => {
      let cur: Record<string, unknown> = { ciphertext: id, title: `Depth ${depth}` };
      for (let i = 0; i < depth; i += 1) {
        cur = { wrapper: cur };
      }
      return cur;
    };
    expect(
      extractSearchProjection(makeNested(14, '~021414141414141414'), {
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
      }).jobs,
    ).toHaveLength(1);
    expect(
      extractSearchProjection(makeNested(15, '~021515151515151515'), {
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
      }).jobs,
    ).toHaveLength(0);

    // Circular reference safety.
    const cyclic: Record<string, unknown> = { ciphertext: '~027777777777777777', title: 'Cyclic' };
    cyclic.self = cyclic;
    const cyclicRes = extractSearchProjection(cyclic, {
      requestUrl: 'https://www.upwork.com/api/graphql/v1',
      pageUrl: 'https://www.upwork.com/nx/search/jobs/',
    });
    expect(cyclicRes.jobs).toHaveLength(1);
    expect(cyclicRes.jobs[0].job_title).toBe('Cyclic');

    // MAX_WALK_NODES = 15_000 stops cleanly without hanging.
    const hugeNoise = Array.from({ length: 16_000 }, (_, i) => ({ k: i }));
    const boundedRes = extractSearchProjection(
      {
        noise: hugeNoise,
        unreachableAfterBudget: { ciphertext: '~026666666666666666', title: 'Beyond Limit' },
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
      },
    );
    expect(boundedRes.jobs).toEqual([]);
  });

  it('distinguishes explicit empty search, non-search GraphQL, and HTTP 200 GraphQL error codes', () => {
    const emptyRes = extractSearchProjection(
      {
        data: {
          search: {
            universalSearchNuxt: {
              userJobSearchV1: {
                paging: { total: 0, offset: 0, count: 20 },
                results: [],
              },
            },
          },
        },
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
        operationName: 'userJobSearchV1',
      },
    );
    expect(emptyRes.matched).toBe(true);
    expect(emptyRes.isExplicitEmpty).toBe(true);
    expect(emptyRes.paging?.hasNextPage).toBe(false);

    const nonSearchRes = extractSearchProjection(
      { data: { featureFlags: { darkMode: true } } },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
        operationName: 'featureFlags',
      },
    );
    expect(nonSearchRes.matched).toBe(false);
    expect(nonSearchRes.isExplicitEmpty).toBe(false);

    const errorCodes = detectGraphQLErrorCodes({
      errors: [
        { extensions: { code: 'UNAUTHENTICATED' }, message: 'Auth required' },
        { extensions: { code: 'FORBIDDEN' } },
        { message: 'Cloudflare Turnstile captcha challenge triggered' },
        { extensions: { classification: 'RATE_LIMITED' }, message: 'Too many requests' },
      ],
    });
    expect(errorCodes).toEqual([
      'UNAUTHENTICATED',
      'FORBIDDEN',
      'CAPTCHA',
      'CHALLENGE',
      'RATE_LIMITED',
    ]);

    const erroredSearch = extractSearchProjection(
      {
        data: { userJobSearchV1: null },
        errors: [{ extensions: { code: 'UNAUTHENTICATED' }, message: 'Unauthorized' }],
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
        operationName: 'userJobSearchV1',
      },
    );
    expect(erroredSearch.matched).toBe(true);
    expect(erroredSearch.isExplicitEmpty).toBe(false);
    expect(erroredSearch.graphqlErrorCodes).toEqual(['UNAUTHENTICATED']);
  });

  it('chunks oversized batches <= maxBytes (UTF-8 aware) without dropping any jobs', () => {
    const encoder = new TextEncoder();
    const emojiDesc = '🚀🔥💻 '.repeat(400); // multi-byte UTF-8
    const jobs: ProjectedGraphQLJob[] = Array.from({ length: 12 }, (_, idx) => ({
      upwork_job_id: `~0200000000000000${String(idx).padStart(2, '0')}`,
      job_title: `Multi-byte Job ${idx} — 日本語テスト`,
      job_description: emojiDesc,
      contract_type: 'fixed',
      budget_amount: '$1,500',
      budget: '$1,500 fixed',
    }));

    const batch = makeBatch(jobs);
    const chunks = chunkSearchBatch(batch, 12_000);
    expect(chunks.length).toBeGreaterThan(1);

    const reassembledIds: string[] = [];
    chunks.forEach((chunk, idx) => {
      const byteLen = encoder.encode(JSON.stringify(chunk)).byteLength;
      expect(byteLen).toBeLessThanOrEqual(12_000);
      expect(chunk.chunkIndex).toBe(idx);
      expect(chunk.chunkCount).toBe(chunks.length);
      for (const j of chunk.jobs) {
        reassembledIds.push(j.upwork_job_id);
      }
    });
    expect(reassembledIds).toEqual(jobs.map((j) => j.upwork_job_id));

    // Single huge job gets description trimmed to fit budget instead of being dropped.
    const hugeSingle = makeBatch([
      {
        upwork_job_id: '~029999999999999900',
        job_title: 'Huge Job',
        job_description: '🚀'.repeat(4_000),
      },
    ]);
    const trimmedChunks = chunkSearchBatch(hugeSingle, 2_048);
    expect(trimmedChunks).toHaveLength(1);
    expect(encoder.encode(JSON.stringify(trimmedChunks[0])).byteLength).toBeLessThanOrEqual(2_048);
    expect(trimmedChunks[0].jobs).toHaveLength(1);
    expect(trimmedChunks[0].jobs[0].upwork_job_id).toBe('~029999999999999900');

    // Empty jobs batch returns as-is.
    const emptyBatch = makeBatch([]);
    expect(chunkSearchBatch(emptyBatch)).toEqual([emptyBatch]);
  });

  it('prevents Apollo batch non-search items from polluting query/paging with stale pageUrl params', () => {
    const ctx = extractSearchRequestContext(
      'https://www.upwork.com/api/graphql/v1',
      JSON.stringify([
        { operationName: 'featureFlags', variables: {} },
        {
          operationName: 'userJobSearchV1',
          variables: {
            requestVariables: {
              userQuery: 'golang',
              paging: { offset: 20, count: 20 },
            },
          },
        },
      ]),
      'https://www.upwork.com/nx/search/jobs/?q=stale_react&page=1&per_page=10',
    );

    expect(ctx.isSearchRequest).toBe(true);
    expect(ctx.operationName).toBe('userJobSearchV1');
    expect(ctx.query).toBe('golang');
    expect(ctx.requestedPaging).toEqual({
      offset: 20,
      count: 20,
      page: 2,
      perPage: 20,
    });
    expect(ctx.items[0]).toEqual({ operationName: 'featureFlags' });
    expect(ctx.items[1]).toEqual({
      operationName: 'userJobSearchV1',
      query: 'golang',
      requestedPaging: { offset: 20, count: 20, page: 2, perPage: 20 },
    });
  });

  it('prefers offset/count arithmetic over stale URL page/per_page in request and container paging', () => {
    const reqCtx = extractSearchRequestContext(
      'https://www.upwork.com/api/graphql/v1',
      JSON.stringify({
        operationName: 'userJobSearchV1',
        variables: {
          requestVariables: {
            userQuery: 'golang',
            paging: { offset: 20, count: 20 },
          },
        },
      }),
      'https://www.upwork.com/nx/search/jobs/?q=golang&page=1&per_page=10',
    );

    expect(reqCtx.requestedPaging).toEqual({
      offset: 20,
      count: 20,
      page: 2,
      perPage: 20,
    });

    const projFromReq = extractSearchProjection(
      {
        data: {
          search: {
            universalSearchNuxt: {
              userJobSearchV1: {
                paging: { total: 100, offset: 20, count: 20 },
                results: [{ ciphertext: '~025555555555555555', title: 'Go Developer' }],
              },
            },
          },
        },
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=golang&page=1&per_page=10',
        operationName: 'userJobSearchV1',
        requestedPaging: { page: 1, perPage: 10 },
      },
    );

    expect(projFromReq.paging).toEqual({
      totalCount: 100,
      offset: 20,
      count: 20,
      page: 2,
      perPage: 20,
      hasNextPage: true,
    });
  });

  it('rejects loose hyphenated non-ISO timestamps like "2-3" while accepting valid ISO offsets', () => {
    const res = extractSearchProjection(
      {
        data: {
          jobSearch: {
            results: [
              {
                ciphertext: '~026666666666666601',
                title: 'Loose Timestamp Rejected',
                publishedOn: '2-3',
              },
              {
                ciphertext: '~026666666666666602',
                title: 'Offset Timestamp Accepted',
                publishedOn: '2026-11-22T20:15:00+02:00',
              },
            ],
          },
        },
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/',
      },
    );

    expect(res.jobs[0].posted_at_est).toBeUndefined();
    expect(res.jobs[1].posted_at_est).toBe('2026-11-22T18:15:00.000Z');
  });

  it('extracts savedJobs Relay {node:{job}} wrappers, jobTile sibling fields, falls back on wrapped non-empty results, and preserves partial last-page pagination', () => {
    // 1. savedJobs Relay { edges: [{ node: { savedAt, job: {...} } }] }
    const savedJobsRes = extractSearchProjection(
      {
        data: {
          savedJobs: {
            edges: [
              {
                node: {
                  savedAt: '2026-11-22T00:00:00Z',
                  job: {
                    ciphertext: '~02savedJob123456',
                    title: 'Saved Go Architect',
                    description: 'Build reliable services',
                    jobType: 'FIXED',
                    fixedPriceAmount: { amount: 2500 },
                  },
                },
              },
            ],
            pageInfo: { hasNextPage: false },
          },
        },
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1?alias=savedJobs',
        pageUrl: 'https://www.upwork.com/nx/find-work/saved-jobs',
        operationName: 'savedJobs',
      },
    );
    expect(savedJobsRes.matched).toBe(true);
    expect(savedJobsRes.isExplicitEmpty).toBe(false);
    expect(savedJobsRes.jobs).toHaveLength(1);
    expect(savedJobsRes.jobs[0]).toMatchObject({
      upwork_job_id: '~02savedJob123456',
      job_title: 'Saved Go Architect',
      budget_amount: '$2,500',
    });

    // 2. Non-empty results with unknown nested wrapper falls through to generic walker
    const wrappedRes = extractSearchProjection(
      {
        data: {
          search: {
            universalSearchNuxt: {
              userJobSearchV1: {
                results: [
                  {
                    wrapper: {
                      ciphertext: '~02wrappedJob1234',
                      title: 'Wrapped Search Job',
                      description: 'Nested under unexpected wrapper',
                    },
                  },
                ],
                paging: { total: 50, offset: 0, count: 20 },
              },
            },
          },
        },
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=go',
        operationName: 'userJobSearchV1',
      },
    );
    expect(wrappedRes.matched).toBe(true);
    expect(wrappedRes.isExplicitEmpty).toBe(false);
    expect(wrappedRes.jobs).toHaveLength(1);
    expect(wrappedRes.jobs[0]?.upwork_job_id).toBe('~02wrappedJob1234');
    expect(wrappedRes.paging?.totalCount).toBe(50);

    // Genuinely empty results: [] still sets isExplicitEmpty: true
    const emptyRes = extractSearchProjection(
      {
        data: {
          search: {
            universalSearchNuxt: {
              userJobSearchV1: {
                results: [],
                paging: { total: 0, offset: 0, count: 20 },
              },
            },
          },
        },
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=none',
        operationName: 'userJobSearchV1',
      },
    );
    expect(emptyRes.matched).toBe(true);
    expect(emptyRes.isExplicitEmpty).toBe(true);
    expect(emptyRes.jobs).toHaveLength(0);

    // 3. jobTile-level sibling field (jobTile.proposalsTier)
    const siblingRes = extractSearchProjection(
      {
        data: {
          search: {
            universalSearchNuxt: {
              userJobSearchV1: {
                results: [
                  {
                    ciphertext: '~02tileSibling123',
                    title: 'Tile Sibling Job',
                    jobTile: {
                      proposalsTier: '0_4',
                      job: {
                        ciphertext: '~02tileSibling123',
                        hourlyBudgetMin: 60,
                        hourlyBudgetMax: 90,
                      },
                    },
                  },
                ],
                paging: { total: 1, offset: 0, count: 1 },
              },
            },
          },
        },
      },
      {
        requestUrl: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
        pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=go',
        operationName: 'userJobSearchV1',
      },
    );
    expect(siblingRes.jobs).toHaveLength(1);
    expect(siblingRes.jobs[0]).toMatchObject({
      job_title: 'Tile Sibling Job',
      rate_range: '$60 - $90',
      proposals_tier: 'Less than 5',
      proposals_count: 4,
    });

    // 4. Partial last page preserves page=2, perPage=50, hasNextPage=false for both body and URL-only requestedPaging
    const lastPagePayload = {
      data: {
        search: {
          universalSearchNuxt: {
            userJobSearchV1: {
              results: [
                { jobTile: { job: { ciphertext: '~02lastPage12345', title: 'Last Page Job' } } },
              ],
              paging: { total: 65, offset: 50, count: 15 },
            },
          },
        },
      },
    };
    const fromBodyPaging = extractSearchProjection(lastPagePayload, {
      requestUrl: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
      pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=go&per_page=50&page=2',
      operationName: 'userJobSearchV1',
      requestedPaging: { offset: 50, count: 50, page: 2, perPage: 50 },
    });
    expect(fromBodyPaging.paging).toEqual({
      totalCount: 65,
      offset: 50,
      count: 15,
      page: 2,
      perPage: 50,
      hasNextPage: false,
    });

    const fromUrlPaging = extractSearchProjection(lastPagePayload, {
      requestUrl: 'https://www.upwork.com/api/graphql/v1?alias=userJobSearchV1',
      pageUrl: 'https://www.upwork.com/nx/search/jobs/?q=go&per_page=50&page=2',
      operationName: 'userJobSearchV1',
      requestedPaging: { page: 2, perPage: 50 },
    });
    expect(fromUrlPaging.paging).toEqual({
      totalCount: 65,
      offset: 50,
      count: 15,
      page: 2,
      perPage: 50,
      hasNextPage: false,
    });
  });
});
