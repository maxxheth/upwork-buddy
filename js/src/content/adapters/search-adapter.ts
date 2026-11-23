import { extractSearchProjection } from '../../shared/graphql-search-parser';
import type {
  ChallengeType,
  PassiveSearchBatch,
  PassiveTapPayload,
  ProjectedGraphQLJob,
  SearchPaginationMeta,
} from '../../shared/protocol';
import type { JobUpsertPayload, SearchSource } from '../../shared/schemas';
import { BUNDLED_SELECTORS, type SelectorConfig } from '../../shared/selectors';
import {
  checkAuthAndChallengeGuards,
  extractUpworkJobID,
  extractViewFields,
  normalizeJobUrl,
  parseClientSpend,
  parseProposalCount,
  queryAllSafe,
} from '../selector-engine';

export interface BuildSearchUrlParams {
  source?: SearchSource;
  query?: string;
  sort?: 'recency' | 'relevance';
  per_page?: 10 | 20 | 50;
  contractor_tier?: number[];
  contract_type?: 'hourly' | 'fixed';
  proposal_tiers?: string[];
  budget_min?: number;
  budget_max?: number;
  hourly_rate_min?: number;
  hourly_rate_max?: number;
  payment_verified_only?: boolean;
  category?: string;
  search_url?: string;
  page?: number;
}

export interface SearchExtractResult {
  ok: boolean;
  jobs: JobUpsertPayload[];
  hasNextPage: boolean;
  viewName: string;
  extractionSource?: 'graphql' | 'hybrid' | 'dom';
  apiPagination?: SearchPaginationMeta;
  errorCode?: 'HUMAN_ACTION_REQUIRED';
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

const UPWORK_ORIGIN = 'https://www.upwork.com';

export function resolveSearchViewName(source: SearchSource = 'search'): string {
  switch (source) {
    case 'best_matches':
      return 'best_matches';
    case 'most_recent':
      return 'most_recent';
    case 'saved_jobs':
      return 'saved_jobs';
    default:
      return 'search_listings';
  }
}

export function buildSearchUrl(params: BuildSearchUrlParams): string {
  if (params.hourly_rate_min !== undefined) {
    if (!Number.isFinite(params.hourly_rate_min) || params.hourly_rate_min < 0) {
      throw new Error('hourly_rate_min must be a non-negative finite number');
    }
  }
  if (params.hourly_rate_max !== undefined) {
    if (!Number.isFinite(params.hourly_rate_max) || params.hourly_rate_max < 0) {
      throw new Error('hourly_rate_max must be a non-negative finite number');
    }
  }
  if (
    params.hourly_rate_min !== undefined &&
    params.hourly_rate_max !== undefined &&
    params.hourly_rate_min > params.hourly_rate_max
  ) {
    throw new Error('hourly_rate_min cannot exceed hourly_rate_max');
  }

  const source = params.source ?? 'search';
  if (params.search_url) {
    const parsed = new URL(params.search_url);
    if (parsed.username || parsed.password) {
      throw new Error('Upwork search URL must not contain credentials');
    }
    if (parsed.origin !== UPWORK_ORIGIN) {
      throw new Error(`Invalid Upwork search URL origin: ${parsed.origin}`);
    }
    if (params.page && params.page > 1) {
      parsed.searchParams.set('page', String(params.page));
    }
    return parsed.toString();
  }

  if (source === 'best_matches') {
    return `${UPWORK_ORIGIN}/nx/find-work/best-matches`;
  }
  if (source === 'most_recent') {
    return `${UPWORK_ORIGIN}/nx/find-work/most-recent`;
  }
  if (source === 'saved_jobs') {
    return `${UPWORK_ORIGIN}/nx/find-work/saved-jobs`;
  }

  const u = new URL(`${UPWORK_ORIGIN}/nx/search/jobs/`);
  if (params.query?.trim()) {
    u.searchParams.set('q', params.query.trim());
  }
  if (params.sort) {
    u.searchParams.set('sort', params.sort);
  }
  if (params.per_page) {
    u.searchParams.set('per_page', String(params.per_page));
  }
  if (params.contractor_tier && params.contractor_tier.length > 0) {
    u.searchParams.set('contractor_tier', params.contractor_tier.join(','));
  }
  if (params.contract_type === 'hourly') {
    u.searchParams.set('t', '0');
  } else if (params.contract_type === 'fixed') {
    u.searchParams.set('t', '1');
  }
  if (params.budget_min !== undefined || params.budget_max !== undefined) {
    const minPart = params.budget_min !== undefined ? String(params.budget_min) : '0';
    const maxPart = params.budget_max !== undefined ? String(params.budget_max) : '';
    u.searchParams.set('amount', `${minPart}-${maxPart}`);
  }
  if (params.hourly_rate_min !== undefined || params.hourly_rate_max !== undefined) {
    const minPart = params.hourly_rate_min !== undefined ? String(params.hourly_rate_min) : '';
    const maxPart = params.hourly_rate_max !== undefined ? String(params.hourly_rate_max) : '';
    u.searchParams.set('hourly_rate', `${minPart}-${maxPart}`);
  }
  if (params.payment_verified_only === true) {
    u.searchParams.set('payment_verified', '1');
  }
  if (params.proposal_tiers && params.proposal_tiers.length > 0) {
    u.searchParams.set('proposals', params.proposal_tiers.join(','));
  }
  if (params.category?.trim()) {
    u.searchParams.set('category2_uid', params.category.trim());
  }
  u.searchParams.set('page', String(params.page && params.page > 0 ? params.page : 1));
  return u.toString();
}

function parseHourlyRangeParts(rateStr: string): {
  rateRange: string;
  rateMin: string;
  rateMax: string;
} {
  const matches = rateStr.match(/\$[0-9,]+(?:\.\d+)?/g) ?? [];
  const first = matches[0] ?? '';
  const second = matches[1] ?? '';
  if (first && second) {
    return {
      rateRange: `${first} - ${second}`,
      rateMin: first,
      rateMax: second,
    };
  }
  if (first) {
    return {
      rateRange: first,
      rateMin: first,
      rateMax: first,
    };
  }
  return {
    rateRange: rateStr,
    rateMin: '',
    rateMax: '',
  };
}

function parsePaymentVerified(raw: string | null | undefined): boolean | undefined {
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (lower.includes('unverified') || lower.includes('not verified')) {
    return false;
  }
  if (lower.includes('verified')) {
    return true;
  }
  return undefined;
}

function mergeProjectedJobRecord(
  existing: ProjectedGraphQLJob | undefined,
  incoming: ProjectedGraphQLJob,
): ProjectedGraphQLJob {
  if (!existing) {
    return { ...incoming };
  }
  const next: ProjectedGraphQLJob = { ...existing, upwork_job_id: incoming.upwork_job_id };

  const stringFields: (keyof ProjectedGraphQLJob)[] = [
    'job_title',
    'canonical_url',
    'url',
    'contract_type',
    'budget_amount',
    'rate_range',
    'rate_min',
    'rate_max',
    'experience_level',
    'duration',
    'hours_per_week',
    'skills',
    'posted_text',
    'posted_at_est',
    'proposals_tier',
    'client_country',
    'client_spent',
  ];
  for (const key of stringFields) {
    const cur = next[key];
    const inc = incoming[key];
    if ((cur === undefined || cur === '') && typeof inc === 'string' && inc !== '') {
      (next as unknown as Record<string, unknown>)[key] = inc;
    }
  }

  if (
    typeof incoming.budget === 'string' &&
    incoming.budget !== '' &&
    (!next.budget ||
      next.budget === 'Not specified' ||
      (next.budget === 'Fixed price' && incoming.budget !== 'Fixed price') ||
      (next.budget === 'Hourly' && incoming.budget !== 'Hourly'))
  ) {
    next.budget = incoming.budget;
  }

  if (
    incoming.job_description &&
    (!next.job_description || incoming.job_description.length > next.job_description.length)
  ) {
    next.job_description = incoming.job_description;
  }

  const numericFields: (keyof ProjectedGraphQLJob)[] = [
    'proposals_count',
    'connects_required',
    'client_rating',
    'client_reviews',
    'client_spent_usd',
    'client_hires',
    'client_hire_rate',
  ];
  for (const key of numericFields) {
    if (next[key] === undefined && incoming[key] !== undefined) {
      (next as unknown as Record<string, unknown>)[key] = incoming[key];
    }
  }

  if (next.payment_verified === undefined && incoming.payment_verified !== undefined) {
    next.payment_verified = incoming.payment_verified;
  }

  return next;
}

function mergePaginationMeta(
  prev: SearchPaginationMeta | undefined,
  next: SearchPaginationMeta | undefined,
): SearchPaginationMeta | undefined {
  if (!next) return prev;
  if (!prev) return { ...next };

  const merged: SearchPaginationMeta = { ...prev };
  if (next.totalCount !== undefined) merged.totalCount = next.totalCount;
  if (next.offset !== undefined) merged.offset = next.offset;
  if (next.count !== undefined) merged.count = next.count;
  if (next.page !== undefined) merged.page = next.page;
  if (next.perPage !== undefined) merged.perPage = next.perPage;
  if (next.hasNextPage !== undefined) merged.hasNextPage = next.hasNextPage;
  if (next.nextCursor !== undefined) {
    merged.nextCursor = next.nextCursor;
  } else if (next.hasNextPage === false) {
    delete merged.nextCursor;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function collectFromPassivePayloads(payloads: PassiveTapPayload[]): {
  byJobId: Map<string, ProjectedGraphQLJob>;
  paging?: SearchPaginationMeta;
} {
  const byJobId = new Map<string, ProjectedGraphQLJob>();
  let paging: SearchPaginationMeta | undefined;

  for (const payload of payloads) {
    const projection = extractSearchProjection(payload.data, {
      requestUrl: payload.url,
      pageUrl: '',
      operationName: payload.operationName,
    });
    for (const job of projection.jobs) {
      byJobId.set(job.upwork_job_id, mergeProjectedJobRecord(byJobId.get(job.upwork_job_id), job));
    }
    if (projection.graphqlErrorCodes.length === 0 && projection.paging) {
      paging = mergePaginationMeta(paging, projection.paging);
    }
  }

  return { byJobId, paging };
}

export function extractJobsFromGraphQLPayloads(
  payloads: PassiveTapPayload[],
): Map<string, Partial<JobUpsertPayload>> {
  const { byJobId } = collectFromPassivePayloads(payloads);
  const out = new Map<string, Partial<JobUpsertPayload>>();
  for (const [id, job] of byJobId) {
    out.set(id, { ...job });
  }
  return out;
}

function detectHasNextPage(doc: Document): boolean {
  const nextCandidates = queryAllSafe(
    doc,
    "a[rel='next'], button[data-test='next-page'], button[data-test='load-more-button'], [data-test='pagination-next'] button, [data-test='pagination-next'] a",
  );
  for (const el of nextCandidates) {
    const disabledAttr = el.getAttribute('disabled');
    const ariaDisabled = el.getAttribute('aria-disabled');
    const isButtonDisabled = 'disabled' in el && Boolean((el as HTMLButtonElement).disabled);
    if (disabledAttr === null && ariaDisabled !== 'true' && !isButtonDisabled) {
      return true;
    }
  }
  return false;
}

export function extractSearchListings(
  doc: Document,
  options: {
    source?: SearchSource;
    query?: string;
    selectors?: SelectorConfig;
    passivePayloads?: PassiveTapPayload[];
    searchBatches?: PassiveSearchBatch[];
    location?: Pick<Location, 'href' | 'pathname'>;
  } = {},
): SearchExtractResult {
  const selectors = options.selectors ?? BUNDLED_SELECTORS;
  const source = options.source ?? 'search';
  const viewName = resolveSearchViewName(source);
  const loc = options.location ?? doc.location ?? { href: UPWORK_ORIGIN, pathname: '/' };

  const probe = checkAuthAndChallengeGuards(doc, loc, selectors);
  if (probe.challengeDetected) {
    return {
      ok: false,
      jobs: [],
      hasNextPage: false,
      viewName,
      errorCode: 'HUMAN_ACTION_REQUIRED',
      challengeType: probe.challengeType ?? 'unknown',
      reason: probe.challengeReason ?? 'Verification challenge detected',
      url: probe.url,
    };
  }

  const graphqlJobsById = new Map<string, ProjectedGraphQLJob>();
  let apiPagination: SearchPaginationMeta | undefined;

  const sortedBatches = [...(options.searchBatches ?? [])].sort(
    (a, b) => a.captureSeq - b.captureSeq || (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0),
  );
  let hasValidGraphQLBatch = false;
  for (const batch of sortedBatches) {
    if ((batch.graphqlErrorCodes?.length ?? 0) > 0 && batch.jobs.length === 0) {
      continue;
    }
    if (batch.captureKind !== 'spa_dom') {
      hasValidGraphQLBatch = true;
    }
    for (const job of batch.jobs) {
      graphqlJobsById.set(
        job.upwork_job_id,
        mergeProjectedJobRecord(graphqlJobsById.get(job.upwork_job_id), job),
      );
    }
    if (batch.paging) {
      apiPagination = mergePaginationMeta(apiPagination, batch.paging);
    }
  }

  const passiveCollected = collectFromPassivePayloads(options.passivePayloads ?? []);
  for (const [jobId, job] of passiveCollected.byJobId) {
    graphqlJobsById.set(jobId, mergeProjectedJobRecord(graphqlJobsById.get(jobId), job));
  }
  if (sortedBatches.length === 0 && passiveCollected.paging) {
    apiPagination = mergePaginationMeta(apiPagination, passiveCollected.paging);
  }

  const viewCfg = selectors.views[viewName] ?? selectors.views.search_listings;
  let containers: Element[] = [];
  if (viewCfg) {
    for (const sel of viewCfg.container_selectors ?? []) {
      const matched = queryAllSafe(doc, sel);
      if (matched.length > 0) {
        containers = matched;
        break;
      }
    }
  }

  const seenKeys = new Set<string>();
  const jobs: JobUpsertPayload[] = [];
  let domJobsCount = 0;
  let graphqlMatchedCount = 0;
  let graphqlOnlyCount = 0;

  if (viewCfg) {
    for (const card of containers) {
      const fields = extractViewFields(card, viewCfg.fields);
      const title = typeof fields.title === 'string' ? fields.title.trim() : '';
      if (!title) {
        continue;
      }

      const rawUrl = typeof fields.url === 'string' ? fields.url : '';
      const canonicalUrl = rawUrl ? normalizeJobUrl(rawUrl) : '';
      const upworkJobId = extractUpworkJobID(canonicalUrl || rawUrl) ?? undefined;
      const dedupKey = upworkJobId || canonicalUrl || title.toLowerCase();
      if (seenKeys.has(dedupKey)) {
        continue;
      }
      seenKeys.add(dedupKey);
      if (canonicalUrl) {
        seenKeys.add(canonicalUrl);
      }

      let hourlyRate = typeof fields.hourly_rate === 'string' ? fields.hourly_rate.trim() : '';
      let budget = typeof fields.budget === 'string' ? fields.budget.trim() : '';
      if (hourlyRate === 'Fixed price' && !budget) {
        budget = 'Fixed price';
        hourlyRate = '';
      }

      let contractType = '';
      let rateRange = '';
      let rateMin = '';
      let rateMax = '';
      let budgetAmount = '';
      let formattedBudget = budget || hourlyRate || 'Not specified';

      if (hourlyRate && hourlyRate !== 'Fixed price') {
        contractType = 'hourly';
        const parts = parseHourlyRangeParts(hourlyRate);
        rateRange = parts.rateRange;
        rateMin = parts.rateMin;
        rateMax = parts.rateMax;
        formattedBudget = rateRange && rateRange !== 'Hourly' ? `${rateRange}/hr` : hourlyRate;
      } else if (budget) {
        contractType = 'fixed';
        budgetAmount = budget === 'Fixed price' ? '' : budget;
        formattedBudget = budget === 'Fixed price' ? 'Fixed price' : `${budget} fixed`;
      }

      const skillsArr = Array.isArray(fields.skills) ? fields.skills : [];
      const postedText = typeof fields.posted === 'string' ? fields.posted : undefined;
      const proposalsTier = typeof fields.proposals === 'string' ? fields.proposals : undefined;
      const proposalsCount = parseProposalCount(proposalsTier);
      const clientSpent = typeof fields.client_spent === 'string' ? fields.client_spent : undefined;
      const clientSpentUsd = parseClientSpend(clientSpent);
      const paymentVerified = parsePaymentVerified(
        typeof fields.payment_verified === 'string' ? fields.payment_verified : undefined,
      );

      const payload: JobUpsertPayload = {
        job_title: title,
        job_description: typeof fields.description === 'string' ? fields.description : '',
        url: canonicalUrl || undefined,
        job_url: canonicalUrl || undefined,
        canonical_url: canonicalUrl || undefined,
        upwork_job_id: upworkJobId,
        source: 'chrome_extension_search',
        source_feed: source,
        source_query: options.query?.trim() || undefined,
        status: 'ready',
        contract_type: contractType,
        budget: formattedBudget,
        rate_range: rateRange,
        rate_min: rateMin,
        rate_max: rateMax,
        budget_amount: budgetAmount,
        experience_level:
          typeof fields.experience_level === 'string' ? fields.experience_level : '',
        duration: typeof fields.duration === 'string' ? fields.duration : undefined,
        skills: skillsArr.join(', '),
        posted_text: postedText,
        proposals_tier: proposalsTier,
        proposals_count: proposalsCount ?? undefined,
        client_country: typeof fields.country === 'string' ? fields.country : undefined,
        client_rating: typeof fields.client_rating === 'number' ? fields.client_rating : undefined,
        client_spent: clientSpent,
        client_spent_usd: clientSpentUsd ?? undefined,
        payment_verified: paymentVerified,
      };

      if (upworkJobId) {
        const gql = graphqlJobsById.get(upworkJobId);
        if (gql) {
          graphqlMatchedCount += 1;
          if (!payload.url && gql.url) {
            payload.url = gql.url;
          }
          if (!payload.job_url && (gql.url || gql.canonical_url)) {
            payload.job_url = gql.url || gql.canonical_url;
          }
          if (!payload.canonical_url && gql.canonical_url) {
            payload.canonical_url = gql.canonical_url;
          }
          if (
            gql.job_description &&
            (!payload.job_description ||
              gql.job_description.length > payload.job_description.length)
          ) {
            payload.job_description = gql.job_description;
          }
          if (!payload.contract_type && gql.contract_type) {
            payload.contract_type = gql.contract_type;
          }
          if (
            (!payload.budget ||
              payload.budget === 'Not specified' ||
              payload.budget === 'Fixed price' ||
              payload.budget === 'Hourly' ||
              payload.budget === 'Hourly/hr') &&
            gql.budget
          ) {
            payload.budget = gql.budget;
          }
          if (!payload.budget_amount && gql.budget_amount) {
            payload.budget_amount = gql.budget_amount;
          }
          if ((!payload.rate_range || payload.rate_range === 'Hourly') && gql.rate_range) {
            payload.rate_range = gql.rate_range;
          }
          if (!payload.rate_min && gql.rate_min) {
            payload.rate_min = gql.rate_min;
          }
          if (!payload.rate_max && gql.rate_max) {
            payload.rate_max = gql.rate_max;
          }
          if (!payload.experience_level && gql.experience_level) {
            payload.experience_level = gql.experience_level;
          }
          if (!payload.duration && gql.duration) {
            payload.duration = gql.duration;
          }
          if (!payload.hours_per_week && gql.hours_per_week) {
            payload.hours_per_week = gql.hours_per_week;
          }
          if (!payload.posted_text && gql.posted_text) {
            payload.posted_text = gql.posted_text;
          }
          if (!payload.posted_at_est && gql.posted_at_est) {
            payload.posted_at_est = gql.posted_at_est;
          }
          if (!payload.client_spent && gql.client_spent) {
            payload.client_spent = gql.client_spent;
          }
          if (payload.client_spent_usd === undefined && gql.client_spent_usd !== undefined) {
            payload.client_spent_usd = gql.client_spent_usd;
          }
          if (payload.payment_verified === undefined && gql.payment_verified !== undefined) {
            payload.payment_verified = gql.payment_verified;
          }
          if (payload.client_rating === undefined && gql.client_rating !== undefined) {
            payload.client_rating = gql.client_rating;
          }
          if (payload.client_reviews === undefined && gql.client_reviews !== undefined) {
            payload.client_reviews = gql.client_reviews;
          }
          if (payload.client_hires === undefined && gql.client_hires !== undefined) {
            payload.client_hires = gql.client_hires;
          }
          if (payload.client_hire_rate === undefined && gql.client_hire_rate !== undefined) {
            payload.client_hire_rate = gql.client_hire_rate;
          }
          if (!payload.proposals_tier && gql.proposals_tier) {
            payload.proposals_tier = gql.proposals_tier;
          }
          if (payload.proposals_count === undefined && gql.proposals_count !== undefined) {
            payload.proposals_count = gql.proposals_count;
          }
          if (payload.connects_required === undefined && gql.connects_required !== undefined) {
            payload.connects_required = gql.connects_required;
          }
          if (!payload.skills && gql.skills) {
            payload.skills = gql.skills;
          }
          if (!payload.client_country && gql.client_country) {
            payload.client_country = gql.client_country;
          }
        }
      }

      jobs.push(payload);
      domJobsCount += 1;
    }
  }

  for (const [jobId, gql] of graphqlJobsById) {
    const canonicalUrl = gql.canonical_url || `${UPWORK_ORIGIN}/jobs/${jobId}/`;
    if (seenKeys.has(jobId) || seenKeys.has(canonicalUrl)) {
      continue;
    }
    const title = gql.job_title?.trim();
    if (!title) {
      continue;
    }
    seenKeys.add(jobId);
    seenKeys.add(canonicalUrl);

    const jobUrl = gql.url || canonicalUrl;
    const gqlPayload: JobUpsertPayload = {
      job_title: title,
      job_description: gql.job_description ?? '',
      url: jobUrl,
      job_url: jobUrl,
      canonical_url: canonicalUrl,
      upwork_job_id: jobId,
      source: 'chrome_extension_graphql',
      source_feed: source,
      source_query: options.query?.trim() || undefined,
      status: 'ready',
      contract_type: gql.contract_type ?? '',
      budget: gql.budget ?? 'Not specified',
      rate_range: gql.rate_range ?? '',
      rate_min: gql.rate_min ?? '',
      rate_max: gql.rate_max ?? '',
      budget_amount: gql.budget_amount ?? '',
      experience_level: gql.experience_level ?? '',
      ...(gql.duration ? { duration: gql.duration } : {}),
      ...(gql.hours_per_week ? { hours_per_week: gql.hours_per_week } : {}),
      skills: gql.skills ?? '',
      ...(gql.posted_text ? { posted_text: gql.posted_text } : {}),
      ...(gql.posted_at_est ? { posted_at_est: gql.posted_at_est } : {}),
      ...(gql.proposals_tier ? { proposals_tier: gql.proposals_tier } : {}),
      ...(gql.proposals_count !== undefined ? { proposals_count: gql.proposals_count } : {}),
      ...(gql.connects_required !== undefined ? { connects_required: gql.connects_required } : {}),
      ...(gql.client_country ? { client_country: gql.client_country } : {}),
      ...(gql.client_rating !== undefined ? { client_rating: gql.client_rating } : {}),
      ...(gql.client_reviews !== undefined ? { client_reviews: gql.client_reviews } : {}),
      ...(gql.client_hires !== undefined ? { client_hires: gql.client_hires } : {}),
      ...(gql.client_spent ? { client_spent: gql.client_spent } : {}),
      ...(gql.client_spent_usd !== undefined ? { client_spent_usd: gql.client_spent_usd } : {}),
      ...(gql.client_hire_rate !== undefined ? { client_hire_rate: gql.client_hire_rate } : {}),
      ...(gql.payment_verified !== undefined ? { payment_verified: gql.payment_verified } : {}),
    };

    jobs.push(gqlPayload);
    graphqlOnlyCount += 1;
  }

  const hasGraphQLSignal = graphqlOnlyCount > 0 || graphqlMatchedCount > 0 || hasValidGraphQLBatch;
  const extractionSource: 'graphql' | 'hybrid' | 'dom' =
    domJobsCount > 0 && hasGraphQLSignal
      ? 'hybrid'
      : domJobsCount > 0
        ? 'dom'
        : hasGraphQLSignal
          ? 'graphql'
          : 'dom';

  const hasNextPage =
    apiPagination?.hasNextPage !== undefined ? apiPagination.hasNextPage : detectHasNextPage(doc);

  return {
    ok: true,
    jobs,
    hasNextPage,
    viewName,
    extractionSource,
    ...(apiPagination ? { apiPagination } : {}),
  };
}
