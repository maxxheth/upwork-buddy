import type { ChallengeType, PassiveTapPayload } from '../../shared/protocol';
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

export function extractJobsFromGraphQLPayloads(
  payloads: PassiveTapPayload[],
): Map<string, Partial<JobUpsertPayload>> {
  const byJobId = new Map<string, Partial<JobUpsertPayload>>();
  const visited = new WeakSet<object>();

  const readString = (obj: Record<string, unknown>, ...keys: string[]): string | undefined => {
    for (const k of keys) {
      const val = obj[k];
      if (typeof val === 'string' && val.trim()) {
        return val.trim();
      }
    }
    return undefined;
  };

  const readNumber = (obj: Record<string, unknown>, ...keys: string[]): number | undefined => {
    for (const k of keys) {
      const val = obj[k];
      if (typeof val === 'number' && Number.isFinite(val)) {
        return val;
      }
    }
    return undefined;
  };

  const readNumberOrAmount = (
    obj: Record<string, unknown>,
    ...keys: string[]
  ): number | undefined => {
    for (const k of keys) {
      const val = obj[k];
      if (typeof val === 'number' && Number.isFinite(val)) {
        return val;
      }
      if (val && typeof val === 'object' && 'amount' in val) {
        const amt = (val as Record<string, unknown>).amount;
        if (typeof amt === 'number' && Number.isFinite(amt)) {
          return amt;
        }
      }
    }
    return undefined;
  };

  const visit = (node: unknown, depth: number): void => {
    if (depth > 8 || node === null || typeof node !== 'object') {
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, depth + 1);
      }
      return;
    }

    const rec = node as Record<string, unknown>;
    const rawCipher =
      readString(rec, 'ciphertext', 'upwork_job_id', 'jobCiphertext', 'uid') ??
      readString(rec, 'url', 'canonical_url');
    const id = extractUpworkJobID(
      rawCipher && !rawCipher.startsWith('~') && /^[0-9a-zA-Z]{8,}$/.test(rawCipher)
        ? `~${rawCipher}`
        : rawCipher,
    );
    const title = readString(rec, 'title', 'subject', 'jobTitle');

    const hasJobDetails = Boolean(
      title ||
        rec.description ||
        rec.client ||
        rec.buyer ||
        rec.totalApplicants !== undefined ||
        rec.connectPrice !== undefined ||
        rec.connects_required !== undefined ||
        rec.connectsRequired !== undefined ||
        rec.proposalsTier !== undefined ||
        rec.proposals_tier !== undefined ||
        rec.jobType !== undefined ||
        rec.fixedPriceAmount !== undefined ||
        rec.hourlyBudgetMin !== undefined ||
        rec.hourlyBudgetMax !== undefined,
    );

    if (id && hasJobDetails) {
      const existing = byJobId.get(id) ?? {};
      const next: Partial<JobUpsertPayload> = { ...existing, upwork_job_id: id };

      if (title && !next.job_title) next.job_title = title;
      const desc = readString(rec, 'description', 'snippet');
      if (desc && (!next.job_description || desc.length > next.job_description.length)) {
        next.job_description = desc;
      }

      const clientObj =
        (rec.client && typeof rec.client === 'object'
          ? (rec.client as Record<string, unknown>)
          : undefined) ??
        (rec.buyer && typeof rec.buyer === 'object'
          ? (rec.buyer as Record<string, unknown>)
          : undefined);

      if (clientObj) {
        const spentNum = readNumberOrAmount(clientObj, 'totalSpent', 'total_spent_usd', 'spentUsd');
        if (spentNum !== undefined && next.client_spent_usd === undefined) {
          next.client_spent_usd = spentNum;
          if (!next.client_spent) {
            next.client_spent = `$${spentNum.toLocaleString('en-US')}`;
          }
        }
        if (typeof clientObj.paymentVerificationStatus === 'string') {
          const pv = clientObj.paymentVerificationStatus.toUpperCase();
          if (pv === 'VERIFIED') next.payment_verified = true;
          else if (pv === 'UNVERIFIED') next.payment_verified = false;
        } else if (typeof clientObj.isPaymentVerified === 'boolean') {
          next.payment_verified = clientObj.isPaymentVerified;
        }
        const rating = readNumber(clientObj, 'totalFeedback', 'score', 'rating');
        if (rating !== undefined && next.client_rating === undefined) {
          next.client_rating = rating;
        }
        const reviews = readNumber(clientObj, 'totalReviews', 'reviewsCount');
        if (reviews !== undefined && next.client_reviews === undefined) {
          next.client_reviews = Math.trunc(reviews);
        }
        const hires = readNumber(clientObj, 'totalHires', 'hires');
        if (hires !== undefined && next.client_hires === undefined) {
          next.client_hires = Math.trunc(hires);
        }
        const hireRate = readNumber(clientObj, 'hireRate', 'hire_rate', 'client_hire_rate');
        if (hireRate !== undefined && next.client_hire_rate === undefined) {
          next.client_hire_rate = hireRate;
        }
        if (clientObj.location && typeof clientObj.location === 'object' && !next.client_country) {
          const country = readString(clientObj.location as Record<string, unknown>, 'country');
          if (country) next.client_country = country;
        }
      }

      const proposalsTier = readString(rec, 'proposalsTier', 'proposals_tier');
      if (proposalsTier && !next.proposals_tier) next.proposals_tier = proposalsTier;
      const proposalsCount = readNumber(
        rec,
        'totalApplicants',
        'proposals_count',
        'proposalsCount',
      );
      if (proposalsCount !== undefined && next.proposals_count === undefined) {
        next.proposals_count = Math.trunc(proposalsCount);
      }
      const connects = readNumber(rec, 'connectPrice', 'connects_required', 'connectsRequired');
      if (connects !== undefined && next.connects_required === undefined) {
        next.connects_required = Math.trunc(connects);
      }

      if (Array.isArray(rec.skills) && !next.skills) {
        const skillNames = rec.skills
          .map((s) => {
            if (typeof s === 'string') return s.trim();
            if (s && typeof s === 'object') {
              return readString(s as Record<string, unknown>, 'prettyName', 'name') ?? '';
            }
            return '';
          })
          .filter(Boolean);
        if (skillNames.length > 0) {
          next.skills = skillNames.join(', ');
        }
      }

      byJobId.set(id, next);
    }

    for (const value of Object.values(rec)) {
      if (value && typeof value === 'object') {
        visit(value, depth + 1);
      }
    }
  };

  for (const payload of payloads) {
    visit(payload.data, 0);
  }

  return byJobId;
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

  const viewCfg = selectors.views[viewName] ?? selectors.views.search_listings;
  if (!viewCfg) {
    return { ok: true, jobs: [], hasNextPage: false, viewName };
  }

  let containers: Element[] = [];
  for (const sel of viewCfg.container_selectors ?? []) {
    const matched = queryAllSafe(doc, sel);
    if (matched.length > 0) {
      containers = matched;
      break;
    }
  }

  const graphqlByJobId = extractJobsFromGraphQLPayloads(options.passivePayloads ?? []);
  const seenKeys = new Set<string>();
  const jobs: JobUpsertPayload[] = [];

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
      formattedBudget = rateRange ? `${rateRange}/hr` : hourlyRate;
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
      experience_level: typeof fields.experience_level === 'string' ? fields.experience_level : '',
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
      const gql = graphqlByJobId.get(upworkJobId);
      if (gql) {
        if (!payload.job_description && gql.job_description) {
          payload.job_description = gql.job_description;
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
  }

  return {
    ok: true,
    jobs,
    hasNextPage: detectHasNextPage(doc),
    viewName,
  };
}
