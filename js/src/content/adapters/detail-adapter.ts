import type { ChallengeType, PassiveTapPayload } from '../../shared/protocol';
import type {
  ClientActivity,
  JobAttachment,
  JobQualification,
  JobUpsertPayload,
  ScreeningQuestion,
} from '../../shared/schemas';
import { BUNDLED_SELECTORS, type SelectorConfig } from '../../shared/selectors';
import type { ContractType, JobInfo } from '../../types';
import { sanitizeHttpUrl } from '../../utils';
import {
  checkAuthAndChallengeGuards,
  extractFullText,
  extractRenderedText,
  extractUpworkJobID,
  extractViewFields,
  hasDetailSignals,
  isJobNotFoundDocument,
  normalizeJobUrl,
  parseClientSpend,
  parseProposalCount,
  queryAllSafe,
} from '../selector-engine';
import { extractJobsFromGraphQLPayloads } from './search-adapter';

export interface ScrapedJobDetail {
  title: string;
  url: string;
  canonical_url: string;
  upwork_job_id: string | null;
  description: string;
  contract_type: ContractType;
  budget: string;
  rate_range: string;
  rate_min: string;
  rate_max: string;
  budget_amount: string;
  experience_level: string;
  duration: string;
  hours_per_week: string;
  skills: string[];
  posted_text: string;
  proposals_tier: string;
  proposals_count: number | null;
  connects_required: number | null;
  client_country: string;
  client_rating: number | null;
  client_reviews: number | null;
  client_spent: string;
  client_spent_usd: number | null;
  client_hires: number | null;
  client_hire_rate: number | null;
  payment_verified: boolean | null;
  client_avg_hourly?: string;
  client_activity: ClientActivity;
  screening_questions: ScreeningQuestion[];
  attachments: JobAttachment[];
  qualifications: JobQualification[];
  last_enriched_at: string;
}

export type DetailErrorCode =
  | 'HUMAN_ACTION_REQUIRED'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'MISSING_SIGNALS';

export interface DetailExtractResult {
  ok: boolean;
  detail?: ScrapedJobDetail;
  payload?: JobUpsertPayload;
  errorCode?: DetailErrorCode;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

export function resolveDetailContainer(doc: Document, requireDrawer = false): Element | null {
  const drawer = doc.querySelector('.job-details-content');
  if (requireDrawer) {
    return drawer;
  }
  return (
    drawer ??
    doc.querySelector('.job-details-card') ??
    doc.querySelector('main') ??
    doc.body ??
    doc.documentElement
  );
}

function isRateLimitedDocument(doc: Document): boolean {
  const alertEls = queryAllSafe(doc, ".air3-alert, h1, [data-test='error-title'], title");
  for (const el of alertEls) {
    const text = extractFullText(el).toLowerCase();
    if (
      text.includes('too many requests') ||
      text.includes('rate limit') ||
      /\bhttp\s*429\b/.test(text)
    ) {
      return true;
    }
  }
  return false;
}

function parseClientReviewsCount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const reviewsMatch = /(\d+)\s+reviews?/i.exec(trimmed);
  if (reviewsMatch) {
    return Number.parseInt(reviewsMatch[1], 10);
  }
  const ofMatch = /of\s+(\d+)/i.exec(trimmed);
  if (ofMatch) {
    return Number.parseInt(ofMatch[1], 10);
  }
  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return null;
}

function parseClientHireRate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /(\d+(?:\.\d+)?)\s*%/.exec(raw);
  if (!m) return null;
  const num = Number(m[1]);
  return Number.isFinite(num) ? num : null;
}

function parsePaymentVerifiedDetail(
  raw: string | null | undefined,
  container: Element,
): boolean | null {
  if (raw) {
    const lower = raw.toLowerCase();
    if (lower.includes('unverified') || lower.includes('not verified')) {
      return false;
    }
    if (lower.includes('verified')) {
      return true;
    }
  }
  if (container.querySelector('.payment-verified, .is-verified')) {
    const elText = extractFullText(
      container.querySelector('.payment-verified, .is-verified'),
    ).toLowerCase();
    if (elText.includes('unverified') || elText.includes('not verified')) {
      return false;
    }
    return true;
  }
  return null;
}

function extractClientAvgHourly(container: Element): string | undefined {
  const candidates = queryAllSafe(
    container,
    "[data-qa='client-hourly-rate'], [data-test='client-avg-hourly'], [data-test='about-client-container'] li, .cfe-ui-job-about-client li",
  );
  for (const el of candidates) {
    const text = extractFullText(el);
    if (
      /avg\s*hourly/i.test(text) ||
      el.matches("[data-qa='client-hourly-rate'], [data-test='client-avg-hourly']")
    ) {
      const rateMatch = /\$[0-9,]+(?:\.\d+)?(?:\s*\/\s*hr)?/i.exec(text);
      if (rateMatch) {
        return rateMatch[0].replace(/\s+/g, '');
      }
    }
  }
  return undefined;
}

function extractClientActivity(container: Element, clientAvgHourly?: string): ClientActivity {
  const activity: ClientActivity = {};
  const items = queryAllSafe(container, 'ul.client-activity-items li.ca-item, li.ca-item');
  for (const li of items) {
    const titleEl = li.querySelector('span.title');
    const valueEl = li.querySelector('span.value');
    if (!titleEl || !valueEl) continue;

    const label = extractFullText(titleEl).toLowerCase();
    const valText = extractFullText(valueEl);
    if (!valText) continue;

    if (label.includes('interviewing')) {
      const n = Number.parseInt(valText.replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n)) activity.interviewing = n;
    } else if (label.includes('unanswered')) {
      const n = Number.parseInt(valText.replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n)) activity.unanswered_invites = n;
    } else if (label.includes('invites sent')) {
      const n = Number.parseInt(valText.replace(/[^\d]/g, ''), 10);
      if (Number.isFinite(n)) activity.invites_sent = n;
    } else if (label.includes('last viewed')) {
      activity.last_viewed = valText;
    }
  }

  const v2Sections = queryAllSafe(
    container,
    "[data-test='proposals-insights-v2-job-activity-section']",
  );
  for (const section of v2Sections) {
    const candidates = queryAllSafe(section, 'div, span');
    for (const el of candidates) {
      if (el.children.length > 0) continue;
      const nextEl = el.nextElementSibling;
      if (!nextEl || nextEl.matches('button, [data-ev-sublocation="!collapse"]')) continue;

      const label = extractFullText(el).toLowerCase().trim();
      if (!label || label.length > 40 || /\d/.test(label)) continue;

      const valText = extractFullText(nextEl).trim();
      const countMatch = /^\(?\s*(\d+)\s*\)?$/.exec(valText);
      if (!countMatch) continue;

      const n = Number.parseInt(countMatch[1], 10);
      if (!Number.isFinite(n)) continue;

      if (
        (label.includes('interviewing') || label.includes('interviews')) &&
        activity.interviewing === undefined
      ) {
        activity.interviewing = n;
      } else if (label.includes('unanswered') && activity.unanswered_invites === undefined) {
        activity.unanswered_invites = n;
      } else if (
        (label.includes('invites sent') || label === 'invites' || label.includes('invites')) &&
        activity.invites_sent === undefined
      ) {
        activity.invites_sent = n;
      }
    }
  }

  if (activity.last_viewed === undefined) {
    const v2Roots = queryAllSafe(container, "[data-test='proposals-insights-v2-job-activity']");
    for (const root of v2Roots) {
      const spans = queryAllSafe(root, 'span');
      for (const span of spans) {
        const label = extractFullText(span).toLowerCase();
        if (!label.includes('last viewed')) continue;
        const valText = span.nextElementSibling
          ? extractFullText(span.nextElementSibling).trim()
          : '';
        if (valText) {
          activity.last_viewed = valText;
          break;
        }
      }
      if (activity.last_viewed !== undefined) break;
    }
  }

  if (clientAvgHourly) {
    activity.avg_hourly_rate_paid = clientAvgHourly;
  }

  return activity;
}

function extractScreeningQuestions(container: Element, selectors: string[]): ScreeningQuestion[] {
  const out: ScreeningQuestion[] = [];
  for (const sel of selectors) {
    const matched = queryAllSafe(container, sel);
    if (matched.length === 0) continue;
    matched.forEach((el, idx) => {
      const prompt = extractRenderedText(el).trim();
      if (!prompt) return;
      const required =
        prompt.includes('*') ||
        el.hasAttribute('required') ||
        Boolean(el.querySelector('[required], .required, .text-danger')) ||
        /\brequired\b/i.test(prompt);
      out.push({ index: idx, prompt, required });
    });
    break;
  }
  return out;
}

function extractAttachments(container: Element, selectors: string[]): JobAttachment[] {
  const out: JobAttachment[] = [];
  for (const sel of selectors) {
    const matched = queryAllSafe(container, sel);
    if (matched.length === 0) continue;
    for (const el of matched) {
      const rawHref = el.getAttribute('href') ?? '';
      const resolved = rawHref.startsWith('/') ? `https://www.upwork.com${rawHref}` : rawHref;
      const safeUrl = sanitizeHttpUrl(resolved) ?? '';
      const filename = extractFullText(el) || safeUrl.split('/').pop() || 'attachment';
      if (filename && safeUrl) {
        out.push({ filename, url: safeUrl });
      }
    }
    break;
  }
  return out;
}

function extractQualifications(container: Element, selectors: string[]): JobQualification[] {
  const out: JobQualification[] = [];
  for (const sel of selectors) {
    const matched = queryAllSafe(container, sel);
    if (matched.length === 0) continue;
    for (const el of matched) {
      const raw = extractFullText(el);
      if (!raw) continue;
      const colonIdx = raw.indexOf(':');
      const rawName = colonIdx !== -1 ? raw.slice(0, colonIdx).trim() : raw;
      const name = rawName.replace(/^[✓✗✔✕•\s]+/, '').trim();
      const value = colonIdx !== -1 ? raw.slice(colonIdx + 1).trim() : '';

      let met: boolean | null = null;
      if (
        el.querySelector(
          ".text-success, [data-test='check-icon'], [aria-label*='met' i], .air3-icon-check",
        )
      ) {
        met = true;
      } else if (
        el.querySelector(
          ".text-danger, .text-warning, [data-test='cross-icon'], [aria-label*='not met' i]",
        )
      ) {
        met = false;
      }
      out.push({ name, value, met });
    }
    break;
  }
  return out;
}

function extractHourlyPartsFromDetail(rawHourly: string): {
  rateRange: string;
  rateMin: string;
  rateMax: string;
} {
  const matches = rawHourly.match(/\$[0-9,]+(?:\.\d+)?/g) ?? [];
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
    rateRange: rawHourly,
    rateMin: '',
    rateMax: '',
  };
}

export function detailToJobInfo(detail: ScrapedJobDetail): JobInfo {
  return {
    title: detail.title || 'Unknown Title',
    description: detail.description || 'No description available',
    contractType: detail.contract_type,
    rateRange: detail.rate_range,
    rateMin: detail.rate_min,
    rateMax: detail.rate_max,
    budgetAmount: detail.budget_amount,
    budget: detail.budget || 'Not specified',
    experienceLevel: detail.experience_level || 'Not specified',
    skills: detail.skills.length > 0 ? detail.skills.join(', ') : 'Not specified',
  };
}

export function detailToUpsertPayload(detail: ScrapedJobDetail): JobUpsertPayload {
  const clientActivity: ClientActivity = { ...detail.client_activity };
  if (detail.client_avg_hourly && !clientActivity.avg_hourly_rate_paid) {
    clientActivity.avg_hourly_rate_paid = detail.client_avg_hourly;
  }

  return {
    job_title: detail.title,
    job_description: detail.description,
    url: detail.canonical_url || undefined,
    job_url: detail.canonical_url || undefined,
    canonical_url: detail.canonical_url || undefined,
    upwork_job_id: detail.upwork_job_id ?? undefined,
    source: 'chrome_extension_detail',
    contract_type: detail.contract_type,
    budget: detail.budget,
    rate_range: detail.rate_range,
    rate_min: detail.rate_min,
    rate_max: detail.rate_max,
    budget_amount: detail.budget_amount,
    experience_level: detail.experience_level,
    duration: detail.duration || undefined,
    hours_per_week: detail.hours_per_week || undefined,
    skills: detail.skills.join(', '),
    posted_text: detail.posted_text || undefined,
    proposals_tier: detail.proposals_tier || undefined,
    proposals_count: detail.proposals_count,
    connects_required: detail.connects_required,
    screening_questions:
      detail.screening_questions.length > 0 ? detail.screening_questions : undefined,
    attachments: detail.attachments.length > 0 ? detail.attachments : undefined,
    qualifications: detail.qualifications.length > 0 ? detail.qualifications : undefined,
    client_country: detail.client_country || undefined,
    client_rating: detail.client_rating,
    client_reviews: detail.client_reviews,
    client_spent: detail.client_spent || undefined,
    client_spent_usd: detail.client_spent_usd,
    client_hires: detail.client_hires,
    client_hire_rate: detail.client_hire_rate,
    payment_verified: detail.payment_verified,
    client_avg_hourly: detail.client_avg_hourly,
    client_activity: Object.keys(clientActivity).length > 0 ? clientActivity : undefined,
    last_enriched_at: detail.last_enriched_at,
  };
}

function extractMultilineDescription(
  container: Element,
  selectors: string[],
  fallbackDescription: string,
): string {
  let descEl: Element | null = null;
  for (const sel of selectors) {
    const matched = queryAllSafe(container, sel);
    if (matched.length > 0) {
      descEl = matched[0];
      break;
    }
  }
  if (!descEl) {
    return fallbackDescription;
  }

  const parts: string[] = [];
  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'noscript') {
      return;
    }
    if (tag === 'br') {
      parts.push('\n');
      return;
    }
    const isBlock = tag === 'p' || tag === 'div' || tag === 'li' || tag === 'section';
    if (isBlock && parts.length > 0) {
      parts.push('\n');
    }
    for (const child of el.childNodes) {
      walk(child);
    }
    if (isBlock) {
      parts.push('\n');
    }
  };

  walk(descEl);
  const raw = parts
    .join('')
    .split('\n')
    .map((line) => line.replace(/[ \t\r]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/^Summary\s*/, '');

  return raw || fallbackDescription;
}

export function extractJobDetail(
  target: Document | Element,
  options: {
    url?: string;
    requireDrawer?: boolean;
    selectors?: SelectorConfig;
    passivePayloads?: PassiveTapPayload[];
    location?: Pick<Location, 'href' | 'pathname'>;
  } = {},
): DetailExtractResult {
  const selectors = options.selectors ?? BUNDLED_SELECTORS;
  const isDocument = 'createElement' in target && 'querySelectorAll' in target;

  let docUrl = options.url ?? '';
  let container: Element | null = null;

  if (isDocument) {
    const doc = target as Document;
    const loc = options.location ??
      doc.location ?? { href: docUrl || 'https://www.upwork.com', pathname: '/' };
    if (!docUrl) {
      docUrl = loc.href || '';
    }

    const probe = checkAuthAndChallengeGuards(doc, loc, selectors);
    if (probe.challengeDetected) {
      return {
        ok: false,
        errorCode: 'HUMAN_ACTION_REQUIRED',
        challengeType: probe.challengeType ?? 'unknown',
        reason: probe.challengeReason ?? 'Verification challenge detected',
        url: probe.url,
      };
    }

    if (isRateLimitedDocument(doc)) {
      return {
        ok: false,
        errorCode: 'RATE_LIMITED',
        reason: 'Rate limited by Upwork (429 / Too Many Requests)',
        url: docUrl,
      };
    }

    if (isJobNotFoundDocument(doc, selectors)) {
      return {
        ok: false,
        errorCode: 'NOT_FOUND',
        reason: 'Job not found, expired, or private',
        url: docUrl,
      };
    }

    container = resolveDetailContainer(doc, options.requireDrawer);
  } else {
    container = target as Element;
  }

  if (!container) {
    return {
      ok: false,
      errorCode: 'MISSING_SIGNALS',
      reason: 'Job detail container not found',
      url: docUrl,
    };
  }

  const viewCfg = selectors.views.job_detail;
  if (!viewCfg) {
    return {
      ok: false,
      errorCode: 'MISSING_SIGNALS',
      reason: 'Missing job_detail selector config',
      url: docUrl,
    };
  }

  const fields = extractViewFields(container, viewCfg.fields);
  const title = typeof fields.title === 'string' ? fields.title.trim() : '';
  const notFoundHeadings = (selectors.page_guards.not_found_headings ?? []).map((h) =>
    h.toLowerCase(),
  );
  if (!title || notFoundHeadings.some((h) => title.toLowerCase().includes(h))) {
    return {
      ok: false,
      errorCode: 'NOT_FOUND',
      reason: 'Missing title or job unavailable heading',
      url: docUrl,
    };
  }

  const fallbackDescription =
    typeof fields.description === 'string' ? fields.description.trim() : '';
  const description = extractMultilineDescription(
    container,
    viewCfg.fields.description?.selectors ?? [],
    fallbackDescription,
  );
  if (!hasDetailSignals(container, description, selectors)) {
    return {
      ok: false,
      errorCode: 'MISSING_SIGNALS',
      reason: 'No description or job detail DOM signals found',
      url: docUrl,
    };
  }

  const rawHourly = typeof fields.hourly_rate === 'string' ? fields.hourly_rate.trim() : '';
  const rawBudget = typeof fields.budget === 'string' ? fields.budget.trim() : '';
  let contractType: ContractType = '';
  let rateRange = '';
  let rateMin = '';
  let rateMax = '';
  let budgetAmount = '';
  let formattedBudget = 'Not specified';

  if (rawHourly) {
    contractType = 'hourly';
    const parts = extractHourlyPartsFromDetail(rawHourly);
    rateRange = parts.rateRange;
    rateMin = parts.rateMin;
    rateMax = parts.rateMax;
    formattedBudget = rateRange ? `${rateRange}/hr` : rawHourly;
  } else if (rawBudget) {
    contractType = 'fixed';
    budgetAmount = rawBudget;
    formattedBudget = `${rawBudget} fixed`;
  }

  let canonicalUrl = docUrl ? normalizeJobUrl(docUrl) : '';
  if (!canonicalUrl) {
    const link = container.querySelector<HTMLAnchorElement>('a[href*="/jobs/"][href*="~"]');
    const href = link?.getAttribute('href') ?? '';
    if (href) {
      canonicalUrl = normalizeJobUrl(href);
    }
  }
  const dataJobId = container.getAttribute('data-job-id')?.trim() ?? '';
  if (!canonicalUrl && /^~[0-9a-zA-Z]+$/.test(dataJobId)) {
    canonicalUrl = `https://www.upwork.com/jobs/${dataJobId}/`;
  }
  const upworkJobId =
    extractUpworkJobID(canonicalUrl || docUrl) ??
    (/^~[0-9a-zA-Z]+$/.test(dataJobId) ? dataJobId : null);

  const clientAvgHourly = extractClientAvgHourly(container);
  const clientActivity = extractClientActivity(container, clientAvgHourly);
  const screeningQuestions = extractScreeningQuestions(
    container,
    viewCfg.fields.screening_questions?.selectors ?? [],
  );
  const attachments = extractAttachments(container, viewCfg.fields.attachments?.selectors ?? []);
  const qualifications = extractQualifications(
    container,
    viewCfg.fields.qualifications?.selectors ?? [],
  );

  const proposalsTier = typeof fields.proposals === 'string' ? fields.proposals.trim() : '';
  const clientSpent = typeof fields.client_spent === 'string' ? fields.client_spent.trim() : '';

  const detail: ScrapedJobDetail = {
    title,
    url: canonicalUrl || docUrl,
    canonical_url: canonicalUrl,
    upwork_job_id: upworkJobId,
    description,
    contract_type: contractType,
    budget: formattedBudget,
    rate_range: rateRange,
    rate_min: rateMin,
    rate_max: rateMax,
    budget_amount: budgetAmount,
    experience_level:
      typeof fields.experience_level === 'string' ? fields.experience_level.trim() : '',
    duration: typeof fields.duration === 'string' ? fields.duration.trim() : '',
    hours_per_week: typeof fields.hours_per_week === 'string' ? fields.hours_per_week.trim() : '',
    skills: Array.isArray(fields.skills) ? fields.skills : [],
    posted_text: typeof fields.posted === 'string' ? fields.posted.trim() : '',
    proposals_tier: proposalsTier,
    proposals_count: parseProposalCount(proposalsTier),
    connects_required:
      typeof fields.connects_required === 'number' ? fields.connects_required : null,
    client_country: typeof fields.country === 'string' ? fields.country.trim() : '',
    client_rating: typeof fields.client_rating === 'number' ? fields.client_rating : null,
    client_reviews: parseClientReviewsCount(
      typeof fields.client_reviews === 'string' ? fields.client_reviews : null,
    ),
    client_spent: clientSpent,
    client_spent_usd: parseClientSpend(clientSpent),
    client_hires: typeof fields.client_hires === 'number' ? fields.client_hires : null,
    client_hire_rate: parseClientHireRate(
      typeof fields.client_hire_rate === 'string' ? fields.client_hire_rate : null,
    ),
    payment_verified: parsePaymentVerifiedDetail(
      typeof fields.payment_verified === 'string' ? fields.payment_verified : null,
      container,
    ),
    ...(clientAvgHourly ? { client_avg_hourly: clientAvgHourly } : {}),
    client_activity: clientActivity,
    screening_questions: screeningQuestions,
    attachments,
    qualifications,
    last_enriched_at: new Date().toISOString(),
  };

  if (upworkJobId && options.passivePayloads && options.passivePayloads.length > 0) {
    const gqlMap = extractJobsFromGraphQLPayloads(options.passivePayloads);
    const gql = gqlMap.get(upworkJobId);
    if (gql) {
      if (!detail.description && gql.job_description) detail.description = gql.job_description;
      if (!detail.proposals_tier && gql.proposals_tier) detail.proposals_tier = gql.proposals_tier;
      if (detail.proposals_count === null && gql.proposals_count !== undefined) {
        detail.proposals_count = gql.proposals_count;
      }
      if (detail.connects_required === null && gql.connects_required !== undefined) {
        detail.connects_required = gql.connects_required;
      }
      if (!detail.client_spent && gql.client_spent) detail.client_spent = gql.client_spent;
      if (detail.client_spent_usd === null && gql.client_spent_usd !== undefined) {
        detail.client_spent_usd = gql.client_spent_usd;
      }
      if (detail.client_rating === null && gql.client_rating !== undefined) {
        detail.client_rating = gql.client_rating;
      }
      if (detail.client_reviews === null && gql.client_reviews !== undefined) {
        detail.client_reviews = gql.client_reviews;
      }
      if (detail.client_hires === null && gql.client_hires !== undefined) {
        detail.client_hires = gql.client_hires;
      }
      if (detail.client_hire_rate === null && gql.client_hire_rate !== undefined) {
        detail.client_hire_rate = gql.client_hire_rate;
      }
      if (detail.payment_verified === null && gql.payment_verified !== undefined) {
        detail.payment_verified = gql.payment_verified;
      }
      if (!detail.client_country && gql.client_country) detail.client_country = gql.client_country;
    }
  }

  return {
    ok: true,
    detail,
    payload: detailToUpsertPayload(detail),
  };
}
