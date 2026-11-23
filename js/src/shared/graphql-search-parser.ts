import type {
  PassiveSearchBatch,
  ProjectedGraphQLJob,
  SearchFeedKind,
  SearchPaginationMeta,
} from './passive-tap-types';

export const KNOWN_SEARCH_OPERATIONS = [
  'userjobsearch',
  'searchjobpostings',
  'universalsearch',
  'marketplacejobpostingssearch',
  'jobsearch',
  'talentjobsearch',
  'bestmatchjobsfeed',
  'mostrecentjobsfeed',
  'savedjobs',
  'savedjobpostings',
  'findworkhome',
] as const;

const MAX_WALK_DEPTH = 14;
const MAX_WALK_NODES = 15_000;
const MAX_DESCRIPTION_CHARS = 16_384;
const DEFAULT_MAX_BATCH_BYTES = 450 * 1024;

export interface SearchRequestContextItem {
  operationName?: string;
  query?: string;
  requestedPaging?: Partial<SearchPaginationMeta>;
}

export interface SearchRequestContext {
  operationNames: (string | undefined)[];
  operationName?: string;
  query?: string;
  requestedPaging?: Partial<SearchPaginationMeta>;
  items: SearchRequestContextItem[];
  isSearchRequest: boolean;
}

export interface ExtractSearchProjectionMeta {
  requestUrl: string;
  pageUrl: string;
  operationName?: string;
  query?: string;
  requestedPaging?: Partial<SearchPaginationMeta>;
}

export interface SearchProjectionResult {
  matched: boolean;
  jobs: ProjectedGraphQLJob[];
  paging?: SearchPaginationMeta;
  isExplicitEmpty: boolean;
  graphqlErrorCodes: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

function readFiniteNumber(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === 'number' && Number.isFinite(val)) {
      return val;
    }
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }
  }
  return undefined;
}

function readNonNegativeNumber(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  const num = readFiniteNumber(obj, ...keys);
  if (num === undefined || num < 0) return undefined;
  return num;
}

function readNonNegativeInt(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  const num = readFiniteNumber(obj, ...keys);
  if (num === undefined || num < 0) return undefined;
  return Math.trunc(num);
}

function parseOptionalIntParam(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function safeParseUrl(rawUrl: string | undefined): URL | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, 'https://www.upwork.com');
  } catch {
    return null;
  }
}

export function isKnownSearchOperation(operationName?: string): boolean {
  if (!operationName || typeof operationName !== 'string') return false;
  const lower = operationName.trim().toLowerCase();
  if (!lower) return false;
  return KNOWN_SEARCH_OPERATIONS.some((op) => lower.includes(op));
}

export function inferSourceFeed(operationName?: string, pageUrl?: string): SearchFeedKind {
  if (operationName && typeof operationName === 'string') {
    const opLower = operationName.toLowerCase();
    if (opLower.includes('bestmatch')) return 'best_matches';
    if (opLower.includes('mostrecent')) return 'most_recent';
    if (opLower.includes('savedjob')) return 'saved_jobs';
  }

  if (pageUrl && typeof pageUrl === 'string') {
    const parsed = safeParseUrl(pageUrl);
    const pathLower = (parsed ? parsed.pathname : pageUrl).toLowerCase();
    if (pathLower.includes('/best-matches')) return 'best_matches';
    if (pathLower.includes('/most-recent')) return 'most_recent';
    if (pathLower.includes('/saved-jobs')) return 'saved_jobs';
  }

  return 'search';
}

function isSearchOrFeedPageUrl(pageUrl?: string): boolean {
  const parsed = safeParseUrl(pageUrl);
  if (!parsed) return false;
  const path = parsed.pathname.toLowerCase();
  return (
    path.includes('/nx/search/jobs') ||
    path.includes('/search/jobs') ||
    path.includes('/nx/find-work/best-matches') ||
    path.includes('/nx/find-work/most-recent') ||
    path.includes('/nx/find-work/saved-jobs')
  );
}

function isGraphqlOrSearchRequestUrl(requestUrl?: string): boolean {
  const parsed = safeParseUrl(requestUrl);
  if (!parsed) return false;
  const path = parsed.pathname.toLowerCase();
  return path.includes('/graphql') || path.includes('/search/jobs') || path.includes('/ab/jobs');
}

export function extractSearchRequestContext(
  requestUrl: string,
  requestBody?: string,
  pageUrl?: string,
): SearchRequestContext {
  const reqUrlObj = safeParseUrl(requestUrl);
  const pageUrlObj = safeParseUrl(pageUrl);

  const urlOp =
    reqUrlObj?.searchParams.get('alias')?.trim() ||
    reqUrlObj?.searchParams.get('operationName')?.trim() ||
    undefined;
  const urlQuery = reqUrlObj?.searchParams.get('q')?.trim() || undefined;

  const pageQuery = pageUrlObj?.searchParams.get('q')?.trim() || undefined;
  const pageParam = parseOptionalIntParam(pageUrlObj?.searchParams.get('page') ?? null);
  const perPageParam = parseOptionalIntParam(pageUrlObj?.searchParams.get('per_page') ?? null);

  let rawEntries: Record<string, unknown>[] = [];
  if (typeof requestBody === 'string' && requestBody.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(requestBody);
      if (Array.isArray(parsed)) {
        rawEntries = parsed.map((entry) => (isRecord(entry) ? entry : {}));
      } else if (isRecord(parsed)) {
        rawEntries = [parsed];
      }
    } catch {
      // Malformed JSON request bodies are tolerated silently.
    }
  }

  if (rawEntries.length === 0) {
    rawEntries = [{}];
  }

  const metaItems = rawEntries.map((entry) => {
    const entryOp = readString(entry, 'operationName');
    const operationName = entryOp ?? (rawEntries.length === 1 ? urlOp : undefined);
    const isSearchOp = isKnownSearchOperation(operationName);
    const allowUrlFallback = isSearchOp || (rawEntries.length === 1 && !operationName);

    const vars = isRecord(entry.variables) ? entry.variables : undefined;
    const reqVars = vars && isRecord(vars.requestVariables) ? vars.requestVariables : undefined;
    const filterObj =
      (vars && isRecord(vars.marketPlaceJobFilter) ? vars.marketPlaceJobFilter : undefined) ??
      (vars && isRecord(vars.marketplaceJobFilter) ? vars.marketplaceJobFilter : undefined) ??
      (reqVars && isRecord(reqVars.marketPlaceJobFilter)
        ? reqVars.marketPlaceJobFilter
        : undefined) ??
      (reqVars && isRecord(reqVars.marketplaceJobFilter)
        ? reqVars.marketplaceJobFilter
        : undefined);

    const explicitQuery =
      readString(reqVars, 'userQuery', 'q', 'query', 'searchTerm') ??
      readString(filterObj, 'searchTerm_eq', 'userQuery', 'query') ??
      readString(vars, 'q', 'query', 'searchTerm', 'userQuery');
    const query = explicitQuery ?? (allowUrlFallback ? (pageQuery ?? urlQuery) : undefined);

    const pagingObj =
      (reqVars && isRecord(reqVars.paging) ? reqVars.paging : undefined) ??
      (vars && isRecord(vars.paging) ? vars.paging : undefined) ??
      (vars && isRecord(vars.pagination) ? vars.pagination : undefined) ??
      vars;

    const offset = readNonNegativeInt(pagingObj, 'offset');
    const count = readNonNegativeInt(pagingObj, 'count', 'first', 'limit');
    const explicitPerPage = readNonNegativeInt(pagingObj, 'perPage', 'per_page') ?? count;
    const explicitPageRaw = readNonNegativeInt(pagingObj, 'page');
    let explicitPage = explicitPageRaw;
    if (explicitPage === undefined && offset !== undefined && count !== undefined && count > 0) {
      explicitPage = Math.floor(offset / count) + 1;
    }

    const hasExplicitPaging =
      offset !== undefined ||
      count !== undefined ||
      explicitPage !== undefined ||
      explicitPerPage !== undefined;

    const perPage = explicitPerPage ?? (allowUrlFallback ? perPageParam : undefined);
    const page = explicitPage ?? (allowUrlFallback ? pageParam : undefined);

    let requestedPaging: Partial<SearchPaginationMeta> | undefined;
    if (
      offset !== undefined ||
      count !== undefined ||
      page !== undefined ||
      perPage !== undefined
    ) {
      requestedPaging = {};
      if (offset !== undefined) requestedPaging.offset = offset;
      if (count !== undefined) requestedPaging.count = count;
      if (page !== undefined) requestedPaging.page = page;
      if (perPage !== undefined) requestedPaging.perPage = perPage;
    }

    const item: SearchRequestContextItem = {
      ...(operationName ? { operationName } : {}),
      ...(query ? { query } : {}),
      ...(requestedPaging ? { requestedPaging } : {}),
    };

    return {
      item,
      isSearchOp,
      explicitQuery,
      hasExplicitPaging,
    };
  });

  const items = metaItems.map((m) => m.item);
  const operationNames = items.map((item) => item.operationName);
  const operationName =
    items.find((item) => isKnownSearchOperation(item.operationName))?.operationName ??
    items.find((item) => item.operationName)?.operationName ??
    urlOp;
  const query =
    metaItems.find((m) => m.isSearchOp && m.explicitQuery)?.explicitQuery ??
    metaItems.find((m) => m.isSearchOp && m.item.query)?.item.query ??
    metaItems.find((m) => m.explicitQuery)?.explicitQuery ??
    metaItems.find((m) => m.item.query)?.item.query;
  const requestedPaging =
    metaItems.find((m) => m.isSearchOp && m.hasExplicitPaging)?.item.requestedPaging ??
    metaItems.find((m) => m.isSearchOp && m.item.requestedPaging)?.item.requestedPaging ??
    metaItems.find((m) => m.hasExplicitPaging)?.item.requestedPaging ??
    metaItems.find((m) => m.item.requestedPaging)?.item.requestedPaging;
  const isSearchRequest =
    operationNames.some((op) => isKnownSearchOperation(op)) ||
    isKnownSearchOperation(urlOp) ||
    (isSearchOrFeedPageUrl(pageUrl) && isGraphqlOrSearchRequestUrl(requestUrl));

  return {
    operationNames,
    ...(operationName ? { operationName } : {}),
    ...(query ? { query } : {}),
    ...(requestedPaging ? { requestedPaging } : {}),
    items,
    isSearchRequest,
  };
}

function mapErrorTextToCodes(text: string, out: Set<string>): void {
  const upper = text.toUpperCase();
  if (
    upper.includes('UNAUTHENTICATED') ||
    upper.includes('UNAUTHORIZED') ||
    upper.includes('LOGIN REQUIRED') ||
    upper.includes('NOT AUTHENTICATED')
  ) {
    out.add('UNAUTHENTICATED');
  }
  if (upper.includes('FORBIDDEN')) {
    out.add('FORBIDDEN');
  }
  if (upper.includes('ACCESS_DENIED') || upper.includes('ACCESS DENIED')) {
    out.add('ACCESS_DENIED');
  }
  if (upper.includes('CAPTCHA') || upper.includes('TURNSTILE')) {
    out.add('CAPTCHA');
  }
  if (upper.includes('CHALLENGE') || upper.includes('CLOUDFLARE')) {
    out.add('CHALLENGE');
  }
  if (
    upper.includes('RATE_LIMITED') ||
    upper.includes('RATE LIMITED') ||
    upper.includes('RATE_LIMIT') ||
    upper.includes('RATE LIMIT') ||
    upper.includes('TOO_MANY_REQUESTS') ||
    upper.includes('TOO MANY REQUESTS')
  ) {
    out.add('RATE_LIMITED');
  }
}

export function detectGraphQLErrorCodes(root: unknown): string[] {
  if (!isRecord(root)) return [];
  const codes = new Set<string>();

  if (root.__projected === true && Array.isArray(root.graphqlErrorCodes)) {
    for (const item of root.graphqlErrorCodes) {
      if (typeof item === 'string' && item.trim()) {
        codes.add(item.trim().toUpperCase());
      }
    }
  }

  if (Array.isArray(root.errors)) {
    for (const err of root.errors) {
      if (!isRecord(err)) continue;
      const ext = isRecord(err.extensions) ? err.extensions : undefined;
      const candidates = [
        readString(ext, 'code', 'classification'),
        readString(err, 'code', 'message'),
      ];
      for (const candidate of candidates) {
        if (candidate) {
          mapErrorTextToCodes(candidate, codes);
        }
      }
    }
  }

  return Array.from(codes);
}

function readNumericAmount(val: unknown, depth = 0): number | undefined {
  if (depth > 3 || val === null || val === undefined) return undefined;
  if (typeof val === 'number') {
    return Number.isFinite(val) ? val : undefined;
  }
  if (typeof val === 'string') {
    const cleaned = val.replace(/[$,\s]/g, '').trim();
    if (!cleaned || !/^-?\d+(?:\.\d+)?$/.test(cleaned)) return undefined;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (isRecord(val)) {
    for (const key of ['amount', 'rawValue', 'value']) {
      if (key in val) {
        const nested = readNumericAmount(val[key], depth + 1);
        if (nested !== undefined) return nested;
      }
    }
  }
  return undefined;
}

function parseClientSpendPure(raw: unknown): number | undefined {
  const direct = readNumericAmount(raw);
  if (direct !== undefined && direct >= 0) return direct;
  if (typeof raw !== 'string') return undefined;

  let cleaned = raw.toLowerCase().trim();
  if (!cleaned) return undefined;
  cleaned = cleaned
    .replace(/total/g, '')
    .replace(/spent/g, '')
    .replace(/[$,+\s]/g, '');
  if (!cleaned) return undefined;

  let mult = 1;
  if (cleaned.endsWith('m')) {
    mult = 1_000_000;
    cleaned = cleaned.slice(0, -1);
  } else if (cleaned.endsWith('k')) {
    mult = 1_000;
    cleaned = cleaned.slice(0, -1);
  }

  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return undefined;
  const num = Number(cleaned);
  return Number.isFinite(num) && num >= 0 ? num * mult : undefined;
}

function parseProposalCountPure(proposals: string | number | null | undefined): number | undefined {
  if (proposals === null || proposals === undefined) return undefined;
  if (typeof proposals === 'number') {
    return Number.isFinite(proposals) ? Math.max(0, Math.trunc(proposals)) : undefined;
  }
  let text = proposals.trim();
  if (!text) return undefined;
  text = text
    .replace(/^Proposals\s*:\s*/i, '')
    .trim()
    .replace(/^\(([^)]+)\)$/, '$1')
    .trim();
  const lower = text.toLowerCase();

  let m = /less\s+than\s+(\d+)/i.exec(lower);
  if (m) {
    return Math.max(0, Number.parseInt(m[1], 10) - 1);
  }

  m = /(\d+)\s*(?:to|-|–)\s*(\d+)/i.exec(lower);
  if (m) {
    return Number.parseInt(m[2], 10);
  }

  m = /(\d+)\s*\+|(?:more\s+than|over)\s+(\d+)/i.exec(lower);
  if (m) {
    const numStr = m[1] || m[2];
    const n = Number.parseInt(numStr, 10);
    return Math.max(n + 1, 999);
  }

  m = /^(\d+)(?:\s+proposals?)?$/i.exec(lower);
  if (m) {
    return Number.parseInt(m[1], 10);
  }

  return undefined;
}

function normalizeProposalsTier(raw: string): string {
  const trimmed = raw.trim();
  const upper = trimmed.toUpperCase().replace(/[\s-]+/g, '_');
  switch (upper) {
    case '0_4':
    case 'LESS_THAN_5':
      return 'Less than 5';
    case '5_9':
    case '5_TO_10':
      return '5 to 10';
    case '10_14':
    case '10_TO_15':
      return '10 to 15';
    case '15_19':
    case '15_TO_20':
      return '15 to 20';
    case '20_49':
    case '20_TO_50':
      return '20 to 50';
    case '50_PLUS':
    case '50_AND_MORE':
    case '50+':
      return '50+';
    default:
      return trimmed;
  }
}

function normalizeExperienceLevel(raw: unknown): string | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw === 1) return 'Entry level';
    if (raw === 2) return 'Intermediate';
    if (raw === 3) return 'Expert';
    return undefined;
  }
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const upper = trimmed.toUpperCase().replace(/[\s-]+/g, '_');
  if (upper === '1' || upper === 'ENTRY_LEVEL' || upper === 'ENTRY') {
    return 'Entry level';
  }
  if (upper === '2' || upper === 'INTERMEDIATE') {
    return 'Intermediate';
  }
  if (upper === '3' || upper === 'EXPERT') {
    return 'Expert';
  }
  return trimmed;
}

function formatUsd(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  if (Number.isInteger(rounded)) {
    return `$${rounded.toLocaleString('en-US')}`;
  }
  return `$${rounded.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function normalizeJobUrlPure(hrefOrUrl: string): string {
  if (!hrefOrUrl) return '';
  const trimmed = hrefOrUrl.trim();
  if (!trimmed) return '';
  let url = trimmed.startsWith('/') ? `https://www.upwork.com${trimmed}` : trimmed;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return '';
    }
  } catch {
    return '';
  }

  const qIdx = url.indexOf('?');
  if (qIdx !== -1) {
    url = url.slice(0, qIdx);
  }
  const hashIdx = url.indexOf('#');
  if (hashIdx !== -1) {
    url = url.slice(0, hashIdx);
  }

  url = url.replace(/span-class-highlight-([A-Za-z0-9_-]+?)-span/g, '$1');
  url = url.replace(/-amp-/g, '-');

  const tildeIdx = url.indexOf('_~');
  if (tildeIdx !== -1) {
    const prefix = url.slice(0, tildeIdx).replace(/-{2,}/g, '-');
    const rest = url.slice(tildeIdx + 2);
    url = `${prefix}_~${rest}`;
  }

  return url;
}

function parseIsoTimestamp(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return undefined;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function looksLikeIsoTimestamp(raw: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2})/.test(raw.trim());
}

function extractNormalizedJobId(raw: unknown, allowBareAlnum: boolean): string | undefined {
  let str: string | undefined;
  if (typeof raw === 'string') {
    str = raw.trim();
  } else if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && Number.isInteger(raw)) {
    str = String(raw);
  }
  if (!str) return undefined;

  const qIdx = str.indexOf('?');
  if (qIdx !== -1) str = str.slice(0, qIdx);
  const hashIdx = str.indexOf('#');
  if (hashIdx !== -1) str = str.slice(0, hashIdx);
  str = str.trim();
  if (!str) return undefined;

  const tildeMatch = /~([0-9a-zA-Z]{8,})/.exec(str);
  if (tildeMatch) {
    return `~${tildeMatch[1]}`;
  }
  if (allowBareAlnum && /^[0-9a-zA-Z]{8,}$/.test(str)) {
    return `~${str}`;
  }
  return undefined;
}

interface ResolvedJobId {
  id: string;
  fromFallbackId: boolean;
}

function extractJobIdFromRecord(rec: Record<string, unknown>): ResolvedJobId | undefined {
  for (const key of ['ciphertext', 'jobCiphertext', 'upwork_job_id']) {
    const id = extractNormalizedJobId(rec[key], true);
    if (id) return { id, fromFallbackId: false };
  }
  for (const key of ['canonical_url', 'url', 'job_url']) {
    const id = extractNormalizedJobId(rec[key], false);
    if (id) return { id, fromFallbackId: false };
  }
  for (const key of ['uid', 'id']) {
    const id = extractNormalizedJobId(rec[key], true);
    if (id) return { id, fromFallbackId: true };
  }
  return undefined;
}

function hasAnyKey(obj: Record<string, unknown> | undefined, keys: readonly string[]): boolean {
  if (!obj) return false;
  return keys.some((k) => obj[k] !== undefined && obj[k] !== null);
}

const GENERAL_JOB_SIGNAL_KEYS = [
  'title',
  'subject',
  'jobTitle',
  'job_title',
  'description',
  'snippet',
  'job_description',
  'jobTile',
  'client',
  'buyer',
  'jobType',
  'contractType',
  'contract_type',
  'fixedPriceAmount',
  'hourlyBudgetMin',
  'hourlyBudgetMax',
  'hourlyBudget',
  'amount',
  'budget',
  'budget_amount',
  'rate_min',
  'rate_max',
  'proposalsTier',
  'proposals_tier',
  'totalApplicants',
  'proposalsCount',
  'proposals_count',
  'connectPrice',
  'connectsRequired',
  'connects_required',
  'publishedOn',
  'publishedDateTime',
  'posted_at_est',
  'ontologySkills',
  'skills',
  'attrs',
] as const;

const STRICT_FALLBACK_JOB_SIGNAL_KEYS = [
  'jobTile',
  'jobType',
  'contractType',
  'contract_type',
  'fixedPriceAmount',
  'hourlyBudgetMin',
  'hourlyBudgetMax',
  'hourlyBudget',
  'connectPrice',
  'connectsRequired',
  'connects_required',
  'proposalsTier',
  'proposals_tier',
  'totalApplicants',
  'proposalsCount',
  'proposals_count',
] as const;

function isValidJobRecord(
  rec: Record<string, unknown>,
  nestedJob: Record<string, unknown> | undefined,
  fromFallbackId: boolean,
  jobTileObj?: Record<string, unknown>,
): boolean {
  if (!fromFallbackId) {
    return (
      hasAnyKey(rec, GENERAL_JOB_SIGNAL_KEYS) ||
      hasAnyKey(nestedJob, GENERAL_JOB_SIGNAL_KEYS) ||
      hasAnyKey(jobTileObj, GENERAL_JOB_SIGNAL_KEYS)
    );
  }
  if (
    hasAnyKey(rec, STRICT_FALLBACK_JOB_SIGNAL_KEYS) ||
    hasAnyKey(nestedJob, STRICT_FALLBACK_JOB_SIGNAL_KEYS) ||
    hasAnyKey(jobTileObj, STRICT_FALLBACK_JOB_SIGNAL_KEYS)
  ) {
    return true;
  }
  const hasPublished =
    hasAnyKey(rec, ['publishedOn', 'publishedDateTime', 'createdOn', 'createdDateTime']) ||
    hasAnyKey(nestedJob, ['publishedOn', 'publishedDateTime', 'createdOn', 'createdDateTime']) ||
    hasAnyKey(jobTileObj, ['publishedOn', 'publishedDateTime', 'createdOn', 'createdDateTime']);
  const hasJobContext =
    hasAnyKey(rec, ['client', 'buyer', 'ontologySkills', 'skills', 'attrs']) ||
    hasAnyKey(nestedJob, ['client', 'buyer', 'ontologySkills', 'skills', 'attrs']) ||
    hasAnyKey(jobTileObj, ['client', 'buyer', 'ontologySkills', 'skills', 'attrs']);
  return hasPublished && hasJobContext;
}

function collectSkills(records: Record<string, unknown>[]): string | undefined {
  const seen = new Set<string>();
  const out: string[] = [];

  const addSkill = (raw: string | undefined): void => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };

  for (const rec of records) {
    for (const field of ['ontologySkills', 'skills', 'attrs']) {
      const val = rec[field];
      if (typeof val === 'string') {
        for (const part of val.split(',')) {
          addSkill(part);
        }
      } else if (Array.isArray(val)) {
        for (const item of val) {
          if (typeof item === 'string') {
            addSkill(item);
          } else if (isRecord(item)) {
            addSkill(readString(item, 'prettyName', 'name', 'label'));
          }
        }
      }
    }
  }

  return out.length > 0 ? out.join(', ') : undefined;
}

function extractJobFields(
  id: string,
  primary: Record<string, unknown>,
  nestedJob?: Record<string, unknown>,
  jobTileObj?: Record<string, unknown>,
): ProjectedGraphQLJob {
  const sources = [nestedJob, jobTileObj, primary].filter((s): s is Record<string, unknown> =>
    Boolean(s),
  );
  const merged = (fn: (obj: Record<string, unknown>) => string | undefined): string | undefined => {
    for (const s of sources) {
      const v = fn(s);
      if (v !== undefined) return v;
    }
    return undefined;
  };
  const mergedVal = (keyList: string[]): unknown => {
    for (const s of sources) {
      for (const k of keyList) {
        if (s[k] !== undefined && s[k] !== null) return s[k];
      }
    }
    return undefined;
  };

  const job: ProjectedGraphQLJob = { upwork_job_id: id };

  const title = merged((s) => readString(s, 'job_title', 'title', 'subject', 'jobTitle'));
  if (title) job.job_title = title;

  let bestDesc: string | undefined;
  for (const s of sources) {
    const candidate = readString(s, 'job_description', 'description', 'snippet');
    if (candidate) {
      const capped =
        candidate.length > MAX_DESCRIPTION_CHARS
          ? candidate.slice(0, MAX_DESCRIPTION_CHARS)
          : candidate;
      if (!bestDesc || capped.length > bestDesc.length) {
        bestDesc = capped;
      }
    }
  }
  if (bestDesc) job.job_description = bestDesc;

  const canonicalUrl = `https://www.upwork.com/jobs/${id}/`;
  job.canonical_url = canonicalUrl;
  const rawUrl = merged((s) => readString(s, 'url', 'job_url', 'canonical_url'));
  const normalizedUrl = rawUrl ? normalizeJobUrlPure(rawUrl) : '';
  job.url = normalizedUrl || canonicalUrl;

  const rawJobType = (
    merged((s) => readString(s, 'jobType', 'contractType', 'contract_type')) ?? ''
  ).toUpperCase();

  const hourlyObj =
    (nestedJob && isRecord(nestedJob.hourlyBudget) ? nestedJob.hourlyBudget : undefined) ??
    (jobTileObj && isRecord(jobTileObj.hourlyBudget) ? jobTileObj.hourlyBudget : undefined) ??
    (isRecord(primary.hourlyBudget) ? primary.hourlyBudget : undefined);
  const hourlyMin =
    readNumericAmount(mergedVal(['hourlyBudgetMin'])) ??
    readNumericAmount(hourlyObj?.min) ??
    readNumericAmount(mergedVal(['rate_min']));
  const hourlyMax =
    readNumericAmount(mergedVal(['hourlyBudgetMax'])) ??
    readNumericAmount(hourlyObj?.max) ??
    readNumericAmount(mergedVal(['rate_max']));

  const isHourly =
    rawJobType === 'HOURLY' ||
    (rawJobType !== 'FIXED' && (hourlyMin !== undefined || hourlyMax !== undefined));

  let fixedAmount: number | undefined;
  for (const key of ['fixedPriceAmount', 'amount', 'budgetAmount', 'budget_amount', 'budget']) {
    for (const s of sources) {
      if (s[key] !== undefined && s[key] !== null) {
        const parsed = readNumericAmount(s[key]);
        if (parsed !== undefined) {
          fixedAmount = parsed;
          break;
        }
      }
    }
    if (fixedAmount !== undefined) break;
  }
  const rawBudgetText = merged((s) => readString(s, 'budget'));
  const isFixed =
    !isHourly &&
    (rawJobType === 'FIXED' ||
      fixedAmount !== undefined ||
      Boolean(rawBudgetText?.toLowerCase().includes('fixed')));

  if (isHourly) {
    job.contract_type = 'hourly';
    if (hourlyMin !== undefined && hourlyMin > 0) {
      job.rate_min = formatUsd(hourlyMin);
    }
    if (hourlyMax !== undefined && hourlyMax > 0) {
      job.rate_max = formatUsd(hourlyMax);
    }
    if (job.rate_min && job.rate_max) {
      job.rate_range = `${job.rate_min} - ${job.rate_max}`;
      job.budget = `${job.rate_range}/hr`;
    } else if (job.rate_min) {
      job.rate_range = `${job.rate_min}+`;
      job.budget = `${job.rate_min}+/hr`;
    } else if (job.rate_max) {
      job.rate_range = `Up to ${job.rate_max}`;
      job.budget = `Up to ${job.rate_max}/hr`;
    } else {
      job.budget = rawBudgetText ?? 'Hourly';
    }
  } else if (isFixed) {
    job.contract_type = 'fixed';
    if (fixedAmount !== undefined && fixedAmount > 0) {
      const formatted = formatUsd(fixedAmount);
      job.budget_amount = formatted;
      job.budget = `${formatted} fixed`;
    } else {
      job.budget_amount = '';
      job.budget = 'Fixed price';
    }
  }

  const rawExp = mergedVal([
    'contractorTier',
    'experienceLevel',
    'experience_level',
    'tierText',
    'tier',
  ]);
  const expLevel = normalizeExperienceLevel(rawExp);
  if (expLevel) job.experience_level = expLevel;

  const duration =
    merged((s) => readString(s, 'durationLabel', 'duration')) ??
    ((): string | undefined => {
      for (const s of sources) {
        for (const durKey of [
          'engagementDuration',
          'fixedPriceEngagementDuration',
          'hourlyEngagementDuration',
        ]) {
          const durObj = s[durKey];
          if (isRecord(durObj)) {
            const label = readString(durObj, 'label', 'name');
            if (label) return label;
          }
        }
      }
      return undefined;
    })();
  if (duration) job.duration = duration;

  const hoursPerWeek = merged((s) => readString(s, 'hoursPerWeek', 'hours_per_week', 'engagement'));
  if (hoursPerWeek) job.hours_per_week = hoursPerWeek;

  const skills = collectSkills(sources);
  if (skills) job.skills = skills;

  const rawTimestamp = merged((s) =>
    readString(
      s,
      'publishedOn',
      'publishedDateTime',
      'createdOn',
      'createdDateTime',
      'posted_at_est',
    ),
  );
  if (rawTimestamp) {
    const iso = parseIsoTimestamp(rawTimestamp);
    if (iso) job.posted_at_est = iso;
  }

  const rawPostedText = merged((s) =>
    readString(s, 'posted_text', 'postedText', 'relativeTime', 'publishedRelativeTime'),
  );
  if (rawPostedText && !looksLikeIsoTimestamp(rawPostedText)) {
    job.posted_text = rawPostedText;
  }

  const rawProposalsTier = merged((s) => readString(s, 'proposalsTier', 'proposals_tier'));
  if (rawProposalsTier) {
    job.proposals_tier = normalizeProposalsTier(rawProposalsTier);
  }

  let proposalsCount: number | undefined;
  for (const s of sources) {
    const c = readNonNegativeInt(s, 'totalApplicants', 'proposalsCount', 'proposals_count');
    if (c !== undefined) {
      proposalsCount = c;
      break;
    }
  }
  if (proposalsCount === undefined && job.proposals_tier) {
    proposalsCount = parseProposalCountPure(job.proposals_tier);
  }
  if (proposalsCount !== undefined) {
    job.proposals_count = proposalsCount;
  }

  for (const s of sources) {
    const connects = readNonNegativeInt(s, 'connectPrice', 'connectsRequired', 'connects_required');
    if (connects !== undefined) {
      job.connects_required = connects;
      break;
    }
  }

  const clientObj =
    (nestedJob && isRecord(nestedJob.client) ? nestedJob.client : undefined) ??
    (nestedJob && isRecord(nestedJob.buyer) ? nestedJob.buyer : undefined) ??
    (jobTileObj && isRecord(jobTileObj.client) ? jobTileObj.client : undefined) ??
    (jobTileObj && isRecord(jobTileObj.buyer) ? jobTileObj.buyer : undefined) ??
    (isRecord(primary.client) ? primary.client : undefined) ??
    (isRecord(primary.buyer) ? primary.buyer : undefined);

  const spentVal =
    clientObj?.totalSpent ??
    clientObj?.total_spent_usd ??
    clientObj?.spentUsd ??
    mergedVal(['client_spent_usd']);
  const spentNum = parseClientSpendPure(spentVal);
  if (spentNum !== undefined) {
    job.client_spent_usd = spentNum;
    const roundedSpent = Math.round(spentNum);
    job.client_spent =
      readString(clientObj, 'client_spent') ??
      merged((s) => readString(s, 'client_spent')) ??
      `$${roundedSpent.toLocaleString('en-US')}`;
  } else {
    const rawSpentStr =
      readString(clientObj, 'client_spent') ?? merged((s) => readString(s, 'client_spent'));
    if (rawSpentStr) job.client_spent = rawSpentStr;
  }

  if (clientObj) {
    const pvRaw = clientObj.paymentVerificationStatus;
    if (typeof pvRaw === 'string') {
      const pv = pvRaw.trim().toUpperCase();
      if (pv === 'VERIFIED' || pv === '1' || pv === 'TRUE') {
        job.payment_verified = true;
      } else if (pv === 'UNVERIFIED' || pv === '0' || pv === 'FALSE') {
        job.payment_verified = false;
      }
    } else if (typeof pvRaw === 'number') {
      if (pvRaw === 1) job.payment_verified = true;
      else if (pvRaw === 0) job.payment_verified = false;
    } else if (typeof clientObj.isPaymentVerified === 'boolean') {
      job.payment_verified = clientObj.isPaymentVerified;
    }
  }
  if (job.payment_verified === undefined) {
    const flatPv = mergedVal(['payment_verified']);
    if (typeof flatPv === 'boolean') {
      job.payment_verified = flatPv;
    }
  }

  const rating =
    readFiniteNumber(clientObj, 'totalFeedback', 'score', 'rating') ??
    readFiniteNumber(nestedJob, 'client_rating') ??
    readFiniteNumber(jobTileObj, 'client_rating') ??
    readFiniteNumber(primary, 'client_rating');
  if (rating !== undefined) job.client_rating = rating;

  const reviews =
    readNonNegativeInt(clientObj, 'totalReviews', 'reviewsCount') ??
    readNonNegativeInt(nestedJob, 'client_reviews') ??
    readNonNegativeInt(jobTileObj, 'client_reviews') ??
    readNonNegativeInt(primary, 'client_reviews');
  if (reviews !== undefined) job.client_reviews = reviews;

  const hires =
    readNonNegativeInt(clientObj, 'totalHires', 'hires') ??
    readNonNegativeInt(nestedJob, 'client_hires') ??
    readNonNegativeInt(jobTileObj, 'client_hires') ??
    readNonNegativeInt(primary, 'client_hires');
  if (hires !== undefined) job.client_hires = hires;

  const hireRate =
    readNonNegativeNumber(clientObj, 'hireRate', 'hire_rate', 'client_hire_rate') ??
    readNonNegativeNumber(nestedJob, 'client_hire_rate') ??
    readNonNegativeNumber(jobTileObj, 'client_hire_rate') ??
    readNonNegativeNumber(primary, 'client_hire_rate');
  if (hireRate !== undefined) job.client_hire_rate = hireRate;

  const country =
    (clientObj && isRecord(clientObj.location)
      ? readString(clientObj.location, 'country')
      : undefined) ??
    readString(clientObj, 'country') ??
    merged((s) => readString(s, 'client_country'));
  if (country) job.client_country = country;

  return job;
}

function mergeProjectedJobs(
  existing: ProjectedGraphQLJob | undefined,
  incoming: ProjectedGraphQLJob,
): ProjectedGraphQLJob {
  if (!existing) return incoming;
  const next: ProjectedGraphQLJob = { ...existing, upwork_job_id: incoming.upwork_job_id };

  const stringFields: (keyof ProjectedGraphQLJob)[] = [
    'job_title',
    'canonical_url',
    'url',
    'contract_type',
    'budget',
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

function tryExtractJobFromRecord(
  rec: Record<string, unknown>,
  byJobId: Map<string, ProjectedGraphQLJob>,
): void {
  const jobTileObj = isRecord(rec.jobTile) ? rec.jobTile : undefined;
  const nestedJob =
    (jobTileObj && isRecord(jobTileObj.job) ? jobTileObj.job : undefined) ??
    (isRecord(rec.job) &&
    (extractJobIdFromRecord(rec) !== undefined ||
      isRecord(rec.client) ||
      isRecord(rec.buyer) ||
      extractJobIdFromRecord(rec.job) !== undefined)
      ? rec.job
      : undefined);

  const resolved =
    extractJobIdFromRecord(rec) ??
    (jobTileObj ? extractJobIdFromRecord(jobTileObj) : undefined) ??
    (nestedJob ? extractJobIdFromRecord(nestedJob) : undefined);
  if (!resolved) return;

  if (!isValidJobRecord(rec, nestedJob, resolved.fromFallbackId, jobTileObj)) {
    return;
  }

  const extracted = extractJobFields(resolved.id, rec, nestedJob, jobTileObj);
  byJobId.set(resolved.id, mergeProjectedJobs(byJobId.get(resolved.id), extracted));
}

function extractPaginationFromContainer(
  container: Record<string, unknown>,
  requestedPaging?: Partial<SearchPaginationMeta>,
): SearchPaginationMeta | undefined {
  const pagingObj = isRecord(container.paging) ? container.paging : undefined;
  const pageInfoObj = isRecord(container.pageInfo) ? container.pageInfo : undefined;

  const totalCount =
    readNonNegativeInt(pagingObj, 'total', 'totalCount') ??
    readNonNegativeInt(container, 'totalCount', 'total');
  const offset = readNonNegativeInt(pagingObj, 'offset') ?? requestedPaging?.offset;
  const count = readNonNegativeInt(pagingObj, 'count') ?? requestedPaging?.count;

  const explicitPerPage = readNonNegativeInt(pagingObj, 'perPage', 'per_page');
  const reqCount = requestedPaging?.count;
  const reqPerPage = requestedPaging?.perPage;

  let perPage: number | undefined;
  if (explicitPerPage !== undefined) {
    perPage = explicitPerPage;
  } else if (reqCount !== undefined && reqCount > 0) {
    perPage = Math.max(reqCount, count ?? 0);
  } else if (
    reqPerPage !== undefined &&
    reqPerPage > 0 &&
    count !== undefined &&
    reqPerPage > count &&
    offset !== undefined &&
    totalCount !== undefined &&
    offset + count >= totalCount &&
    offset % reqPerPage === 0
  ) {
    perPage = reqPerPage;
  } else {
    perPage = count ?? reqPerPage;
  }

  let page = readNonNegativeInt(pagingObj, 'page');
  const divisor = perPage ?? count;
  if (page === undefined && offset !== undefined && divisor !== undefined && divisor > 0) {
    page = Math.floor(offset / divisor) + 1;
  }
  if (page === undefined) {
    page = requestedPaging?.page;
  }

  let hasNextPage: boolean | undefined;
  if (pageInfoObj && typeof pageInfoObj.hasNextPage === 'boolean') {
    hasNextPage = pageInfoObj.hasNextPage;
  } else if (pagingObj && typeof pagingObj.hasNextPage === 'boolean') {
    hasNextPage = pagingObj.hasNextPage;
  } else if (totalCount !== undefined && offset !== undefined && count !== undefined) {
    hasNextPage = offset + count < totalCount;
  }

  const nextCursor =
    readString(pageInfoObj, 'endCursor', 'nextCursor') ??
    readString(pagingObj, 'nextCursor', 'endCursor');

  if (
    totalCount === undefined &&
    offset === undefined &&
    count === undefined &&
    page === undefined &&
    perPage === undefined &&
    hasNextPage === undefined &&
    nextCursor === undefined
  ) {
    return undefined;
  }

  const out: SearchPaginationMeta = {};
  if (totalCount !== undefined) out.totalCount = totalCount;
  if (offset !== undefined) out.offset = offset;
  if (count !== undefined) out.count = count;
  if (page !== undefined) out.page = page;
  if (perPage !== undefined) out.perPage = perPage;
  if (hasNextPage !== undefined) out.hasNextPage = hasNextPage;
  if (nextCursor !== undefined) out.nextCursor = nextCursor;
  return out;
}

function normalizeProjectedPaging(
  rawPaging: unknown,
  requestedPaging?: Partial<SearchPaginationMeta>,
): SearchPaginationMeta | undefined {
  if (!isRecord(rawPaging)) {
    return requestedPaging ? { ...requestedPaging } : undefined;
  }
  const out: SearchPaginationMeta = {};
  const totalCount =
    readNonNegativeInt(rawPaging, 'totalCount', 'total_count', 'total') ??
    requestedPaging?.totalCount;
  const offset = readNonNegativeInt(rawPaging, 'offset') ?? requestedPaging?.offset;
  const count = readNonNegativeInt(rawPaging, 'count') ?? requestedPaging?.count;
  let page = readNonNegativeInt(rawPaging, 'page');
  if (page === undefined && offset !== undefined && count !== undefined && count > 0) {
    page = Math.floor(offset / count) + 1;
  }
  if (page === undefined) {
    page = requestedPaging?.page;
  }
  const perPage =
    readNonNegativeInt(rawPaging, 'perPage', 'per_page') ?? count ?? requestedPaging?.perPage;
  const hasNextPage =
    typeof rawPaging.hasNextPage === 'boolean'
      ? rawPaging.hasNextPage
      : typeof rawPaging.has_next_page === 'boolean'
        ? rawPaging.has_next_page
        : requestedPaging?.hasNextPage;
  const nextCursor =
    readString(rawPaging, 'nextCursor', 'next_cursor', 'endCursor') ?? requestedPaging?.nextCursor;

  if (totalCount !== undefined) out.totalCount = totalCount;
  if (offset !== undefined) out.offset = offset;
  if (count !== undefined) out.count = count;
  if (page !== undefined) out.page = page;
  if (perPage !== undefined) out.perPage = perPage;
  if (hasNextPage !== undefined) out.hasNextPage = hasNextPage;
  if (nextCursor !== undefined) out.nextCursor = nextCursor;
  return Object.keys(out).length > 0 ? out : undefined;
}

function findFastPathContainer(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const roots: Record<string, unknown>[] = [data];
  if (isRecord(data.data)) {
    roots.push(data.data);
    if (isRecord(data.data.data)) {
      roots.push(data.data.data);
    }
  }

  for (const root of roots) {
    if (isRecord(root.search) && isRecord(root.search.universalSearchNuxt)) {
      const v1 = root.search.universalSearchNuxt.userJobSearchV1;
      if (isRecord(v1)) return v1;
    }
    if (isRecord(root.universalSearchNuxt) && isRecord(root.universalSearchNuxt.userJobSearchV1)) {
      return root.universalSearchNuxt.userJobSearchV1;
    }
    if (isRecord(root.userJobSearchV1)) {
      return root.userJobSearchV1;
    }

    if (isRecord(root.marketplaceJobPostingsSearch)) {
      return root.marketplaceJobPostingsSearch;
    }

    for (const key of [
      'bestMatchJobsFeed',
      'mostRecentJobsFeed',
      'savedJobs',
      'savedJobPostings',
      'talentJobSearch',
    ]) {
      if (isRecord(root[key])) return root[key];
    }
    if (isRecord(root.findWorkHome)) {
      if (isRecord(root.findWorkHome.bestMatchJobsFeed)) {
        return root.findWorkHome.bestMatchJobsFeed;
      }
      if (isRecord(root.findWorkHome.mostRecentJobsFeed)) {
        return root.findWorkHome.mostRecentJobsFeed;
      }
    }

    for (const key of ['jobSearch', 'searchJobPostings']) {
      if (isRecord(root[key])) return root[key];
    }
  }

  return undefined;
}

export function extractSearchProjection(
  data: unknown,
  meta: ExtractSearchProjectionMeta,
): SearchProjectionResult {
  const graphqlErrorCodes = detectGraphQLErrorCodes(data);

  if (!isRecord(data) && !Array.isArray(data)) {
    return {
      matched: false,
      jobs: [],
      isExplicitEmpty: false,
      graphqlErrorCodes,
    };
  }

  if (isRecord(data) && data.__projected === true && Array.isArray(data.jobs)) {
    const byJobId = new Map<string, ProjectedGraphQLJob>();
    for (const item of data.jobs) {
      if (isRecord(item)) {
        tryExtractJobFromRecord(item, byJobId);
      }
    }
    const jobs = Array.from(byJobId.values());
    const paging = normalizeProjectedPaging(data.paging, meta.requestedPaging);
    return {
      matched: true,
      jobs,
      ...(paging ? { paging } : {}),
      isExplicitEmpty: jobs.length === 0 && graphqlErrorCodes.length === 0,
      graphqlErrorCodes,
    };
  }

  if (isRecord(data)) {
    const container = findFastPathContainer(data);
    if (container) {
      const byJobId = new Map<string, ProjectedGraphQLJob>();
      const rawItems: unknown[] = Array.isArray(container.results)
        ? container.results
        : Array.isArray(container.edges)
          ? container.edges.map((edge) =>
              isRecord(edge) && edge.node !== undefined ? edge.node : edge,
            )
          : [];

      for (const item of rawItems) {
        if (isRecord(item)) {
          tryExtractJobFromRecord(item, byJobId);
        }
      }

      const jobs = Array.from(byJobId.values());
      const paging = extractPaginationFromContainer(container, meta.requestedPaging);
      const hasExplicitItemsList =
        Array.isArray(container.results) || Array.isArray(container.edges);
      const isExplicitEmpty =
        jobs.length === 0 &&
        graphqlErrorCodes.length === 0 &&
        ((hasExplicitItemsList && rawItems.length === 0) || paging?.totalCount === 0);

      if (jobs.length > 0 || isExplicitEmpty || graphqlErrorCodes.length > 0) {
        return {
          matched: true,
          jobs,
          ...(paging ? { paging } : {}),
          isExplicitEmpty,
          graphqlErrorCodes,
        };
      }
    }
  }

  const byJobId = new Map<string, ProjectedGraphQLJob>();
  const visited = new WeakSet<object>();
  let nodeCount = 0;
  let detectedPaging: SearchPaginationMeta | undefined;
  let sawExplicitEmptyContainer = false;

  const visit = (node: unknown, depth: number): void => {
    if (
      depth > MAX_WALK_DEPTH ||
      nodeCount >= MAX_WALK_NODES ||
      node === null ||
      typeof node !== 'object'
    ) {
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);
    nodeCount += 1;

    if (Array.isArray(node)) {
      for (const item of node) {
        if (nodeCount >= MAX_WALK_NODES) break;
        visit(item, depth + 1);
      }
      return;
    }

    const rec = node as Record<string, unknown>;
    tryExtractJobFromRecord(rec, byJobId);

    const hasResultsOrEdges = Array.isArray(rec.results) || Array.isArray(rec.edges);
    if (
      hasResultsOrEdges &&
      (rec.paging !== undefined ||
        rec.pageInfo !== undefined ||
        rec.totalCount !== undefined ||
        rec.total !== undefined)
    ) {
      if (!detectedPaging) {
        detectedPaging = extractPaginationFromContainer(rec, meta.requestedPaging);
      }
      if (
        (Array.isArray(rec.results) && rec.results.length === 0) ||
        (Array.isArray(rec.edges) && rec.edges.length === 0)
      ) {
        sawExplicitEmptyContainer = true;
      }
    }

    for (const val of Object.values(rec)) {
      if (nodeCount >= MAX_WALK_NODES) break;
      if (val && typeof val === 'object') {
        visit(val, depth + 1);
      }
    }
  };

  visit(data, 0);

  const jobs = Array.from(byJobId.values());
  const paging = detectedPaging ?? (meta.requestedPaging ? { ...meta.requestedPaging } : undefined);

  if (jobs.length > 0) {
    return {
      matched: true,
      jobs,
      ...(paging ? { paging } : {}),
      isExplicitEmpty: false,
      graphqlErrorCodes,
    };
  }

  if (isKnownSearchOperation(meta.operationName)) {
    if (graphqlErrorCodes.length > 0) {
      return {
        matched: true,
        jobs: [],
        ...(paging ? { paging } : {}),
        isExplicitEmpty: false,
        graphqlErrorCodes,
      };
    }
    if (sawExplicitEmptyContainer || paging?.totalCount === 0) {
      return {
        matched: true,
        jobs: [],
        ...(paging ? { paging } : {}),
        isExplicitEmpty: true,
        graphqlErrorCodes,
      };
    }
  }

  return {
    matched: false,
    jobs: [],
    ...(paging ? { paging } : {}),
    isExplicitEmpty: false,
    graphqlErrorCodes,
  };
}

function utf8ByteLength(str: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(str).byteLength;
  }
  if (typeof Blob !== 'undefined') {
    return new Blob([str]).size;
  }
  let bytes = 0;
  for (let i = 0; i < str.length; i += 1) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function fitSingleJobToBudget(
  baseBatch: PassiveSearchBatch,
  job: ProjectedGraphQLJob,
  maxBytes: number,
  chunkIndex: number,
  chunkCountPlaceholder: number,
): ProjectedGraphQLJob {
  const testWith = (candidateJob: ProjectedGraphQLJob): number =>
    utf8ByteLength(
      JSON.stringify({
        ...baseBatch,
        jobs: [candidateJob],
        chunkIndex,
        chunkCount: chunkCountPlaceholder,
      }),
    );

  if (testWith(job) <= maxBytes || !job.job_description) {
    return job;
  }

  let lo = 0;
  let hi = job.job_description.length;
  let best = '';

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    let sliceEnd = mid;
    if (sliceEnd > 0 && sliceEnd < job.job_description.length) {
      const prevCode = job.job_description.charCodeAt(sliceEnd - 1);
      if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
        sliceEnd -= 1;
      }
    }
    const trimmedDesc = job.job_description.slice(0, sliceEnd);
    const size = testWith({ ...job, job_description: trimmedDesc });
    if (size <= maxBytes) {
      best = trimmedDesc;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (best.length === 0) {
    const withoutDesc: ProjectedGraphQLJob = { ...job };
    delete withoutDesc.job_description;
    if (testWith(withoutDesc) <= maxBytes) {
      return withoutDesc;
    }
    return { ...job, job_description: '' };
  }

  return { ...job, job_description: best };
}

export function chunkSearchBatch(
  batch: PassiveSearchBatch,
  maxBytes: number = DEFAULT_MAX_BATCH_BYTES,
): PassiveSearchBatch[] {
  if (batch.jobs.length === 0) {
    return [batch];
  }

  if (utf8ByteLength(JSON.stringify(batch)) <= maxBytes) {
    return [batch];
  }

  const rawChunks: ProjectedGraphQLJob[][] = [];
  let currentJobs: ProjectedGraphQLJob[] = [];
  const placeholderCount = Math.max(2, batch.jobs.length);

  for (const job of batch.jobs) {
    const candidateJobs = [...currentJobs, job];
    const candidateBatch: PassiveSearchBatch = {
      ...batch,
      jobs: candidateJobs,
      chunkIndex: rawChunks.length,
      chunkCount: placeholderCount,
    };

    if (utf8ByteLength(JSON.stringify(candidateBatch)) <= maxBytes) {
      currentJobs = candidateJobs;
      continue;
    }

    if (currentJobs.length > 0) {
      rawChunks.push(currentJobs);
      currentJobs = [];
    }

    const fittedJob = fitSingleJobToBudget(
      batch,
      job,
      maxBytes,
      rawChunks.length,
      placeholderCount,
    );
    currentJobs = [fittedJob];
  }

  if (currentJobs.length > 0) {
    rawChunks.push(currentJobs);
  }

  const totalChunks = rawChunks.length;
  return rawChunks.map((jobs, idx) => ({
    ...batch,
    jobs,
    ...(totalChunks > 1 ? { chunkIndex: idx, chunkCount: totalChunks } : {}),
  }));
}
