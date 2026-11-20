import type { SessionProbeResult } from '../shared/protocol';
import {
  type AuthAndChallengeGuardsConfig,
  BUNDLED_SELECTORS,
  type FieldSelectorRule,
  loadActiveSelectors,
  type SelectorConfig,
} from '../shared/selectors';
import { detectChallengeOrAuth } from './guards';

export type ExtractedFieldValue = string | string[] | number | null;

export interface ParsedJobRecord {
  title: string;
  url: string;
  upwork_job_id: string | null;
  description: string;
  budget: string | null;
  hourly_rate: string | null;
  experience_level: string | null;
  duration: string | null;
  hours_per_week: string | null;
  skills: string[];
  posted: string | null;
  country: string | null;
  proposals: string | null;
  client_rating: number | null;
  client_reviews: string | null;
  client_spent: string | null;
  client_hires: number | null;
  payment_verified: string | null;
  client_hire_rate: string | null;
  connects_required: number | null;
  client_activity: string[];
  screening_questions: string[];
  attachments: string[];
  qualifications: string[];
}

export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
]);

export const NON_RENDERED_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'template',
  'noscript',
]);

function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

export function queryAllSafe(root: Document | Element | ParentNode, selector: string): Element[] {
  const results: Element[] = [];
  if (typeof Element !== 'undefined' && root instanceof Element && safeMatches(root, selector)) {
    results.push(root);
  }
  try {
    const matched = root.querySelectorAll(selector);
    for (const el of matched) {
      if (!results.includes(el)) {
        results.push(el);
      }
    }
  } catch {
    // Ignore invalid/unsupported CSS selector
  }
  return results;
}

/**
 * Mirrors Scrapling/lxml `el.text.strip()`: reads text nodes up to the first child Element,
 * skipping comment/PI nodes without breaking, without collapsing internal whitespace.
 */
export function extractDirectText(el: Element | null | undefined): string {
  if (!el) return '';
  let buf = '';
  let child = el.firstChild;
  while (child) {
    if (child.nodeType === 1) {
      break;
    }
    if (child.nodeType === 3) {
      buf += child.nodeValue ?? '';
    }
    child = child.nextSibling;
  }
  return buf.trim();
}

/**
 * Mirrors Scrapling `el.get_all_text()` + `re.sub(r"\s+", " ", ...).strip()`:
 * skips <script> and <style>, inserts space boundaries around child Elements (not comments),
 * and collapses whitespace.
 */
export function extractFullText(el: Element | null | undefined): string {
  if (!el) return '';
  const parts: string[] = [];

  const walk = (node: Node): void => {
    if (node.nodeType === 3) {
      parts.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) {
      return;
    }
    const elem = node as Element;
    const tag = elem.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style') {
      parts.push(' ');
      return;
    }
    parts.push(' ');
    for (const child of elem.childNodes) {
      walk(child);
    }
    parts.push(' ');
  };

  walk(el);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Mirrors `upwork-scraper-fs/src/parser.py:_rendered_text`:
 * - Inline elements join with zero extra spaces
 * - BLOCK_TAGS (39) emit a single space before & after
 * - NON_RENDERED_TAGS (script, style, template, noscript) and comments/PI are skipped
 *   while preserving following sibling text nodes (.tail in lxml)
 */
export function extractRenderedText(node: Node | null | undefined): string {
  if (!node) return '';
  if (node.nodeType === 3) {
    return (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
  }

  const parts: string[] = [];
  const walk = (current: Node): void => {
    if (current.nodeType === 3) {
      parts.push(current.nodeValue ?? '');
      return;
    }
    if (current.nodeType !== 1) {
      return;
    }
    const elem = current as Element;
    const tag = elem.tagName.toLowerCase();
    if (NON_RENDERED_TAGS.has(tag)) {
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) {
      parts.push(' ');
    }
    for (const child of elem.childNodes) {
      walk(child);
    }
    if (isBlock) {
      parts.push(' ');
    }
  };

  walk(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export function normalizeJobUrl(hrefOrUrl: string): string {
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

export function extractUpworkJobID(urlOrId: string | null | undefined): string | null {
  if (!urlOrId) return null;
  const m = /(~[0-9a-zA-Z]+)/.exec(urlOrId);
  return m ? m[1] : null;
}

export function parseProposalCount(proposals: string | number | null | undefined): number | null {
  if (proposals === null || proposals === undefined) return null;
  if (typeof proposals === 'number') {
    return Number.isFinite(proposals) ? Math.max(0, Math.trunc(proposals)) : null;
  }
  let text = proposals.trim();
  if (!text) return null;
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

  return null;
}

export function parseClientSpend(spend: string | null | undefined): number | null {
  if (!spend) return null;
  let cleaned = spend.toLowerCase().trim();
  if (!cleaned) return null;
  cleaned = cleaned
    .replace(/total/g, '')
    .replace(/spent/g, '')
    .replace(/[$,+\s]/g, '');
  if (!cleaned) return null;

  let mult = 1;
  if (cleaned.endsWith('m')) {
    mult = 1_000_000;
    cleaned = cleaned.slice(0, -1);
  } else if (cleaned.endsWith('k')) {
    mult = 1_000;
    cleaned = cleaned.slice(0, -1);
  }

  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) {
    return null;
  }
  const num = Number(cleaned);
  return Number.isFinite(num) ? num * mult : null;
}

export function applyTransform(
  val: ExtractedFieldValue,
  transformName: string,
): ExtractedFieldValue {
  if (typeof val !== 'string') {
    return val;
  }
  switch (transformName) {
    case 'normalize_job_url':
      return normalizeJobUrl(val);
    case 'strip_est_budget_prefix':
      return val.replace(/^Est\.\s*budget:\s*/i, '').trim();
    case 'strip_est_time_prefix':
      return val.replace(/Est\.\s*time:\s*/gi, '').trim();
    case 'strip_summary_prefix':
      return val.replace(/^Summary\s*/, '');
    case 'strip_total_suffix': {
      const idx = val.indexOf(' total');
      return idx !== -1 ? val.slice(0, idx) : val;
    }
    case 'clean_proposals_text':
      return val
        .replace(/^Proposals\s*:\s*/i, '')
        .trim()
        .replace(/Close the tooltip.*$/i, '')
        .trim()
        .replace(/^\(([^)]+)\)$/, '$1')
        .trim();
    case 'first_token_float': {
      const token = val.trim().split(/\s+/)[0] ?? '';
      if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(token)) {
        return val;
      }
      const num = Number(token);
      return Number.isFinite(num) ? num : val;
    }
    case 'first_token_int': {
      const token = val.trim().split(/\s+/)[0] ?? '';
      if (!/^[+-]?\d+$/.test(token)) {
        return val;
      }
      const num = Number.parseInt(token, 10);
      return Number.isSafeInteger(num) ? num : val;
    }
    case 'rating_out_of_5_float': {
      const m = /(\d+(?:\.\d+)?)\s*(?:out of|of)\s*5/.exec(val);
      if (!m) return val;
      const num = Number(m[1]);
      return Number.isFinite(num) ? num : val;
    }
    default:
      return val;
  }
}

export function applyTransforms(
  val: ExtractedFieldValue,
  transforms?: string[],
): ExtractedFieldValue {
  if (!transforms || transforms.length === 0) return val;
  let result = val;
  for (const t of transforms) {
    result = applyTransform(result, t);
  }
  return result;
}

export function extractCaItemValue(matched: Element[], labelContains?: string): string | null {
  const labelReq = labelContains ?? '';
  const normalizedReq = labelReq.trim().replace(/:$/, '').trim().toLowerCase();
  let rawVal: string | null = null;
  for (const item of matched) {
    const titleSpan = item.querySelector('span.title');
    if (titleSpan) {
      if (extractDirectText(titleSpan).includes(labelReq)) {
        const valSpan = item.querySelector('span.value');
        if (valSpan) {
          rawVal = extractDirectText(valSpan);
          break;
        }
      }
      continue;
    }
    if (normalizedReq) {
      for (const el of item.querySelectorAll('*')) {
        if (el.children.length > 0) continue;
        const labelText = extractFullText(el).trim().replace(/:$/, '').trim().toLowerCase();
        const nextEl = el.nextElementSibling;
        if (
          labelText === normalizedReq &&
          nextEl &&
          nextEl.tagName.toLowerCase() !== 'button' &&
          nextEl.getAttribute('data-ev-sublocation') !== '!collapse'
        ) {
          const valText = extractFullText(nextEl).trim();
          if (valText) {
            rawVal = valText.replace(/^\(([^)]+)\)$/, '$1').trim();
            break;
          }
        }
      }
      if (rawVal !== null) {
        break;
      }
    }
  }
  if (rawVal === null && matched.length === 1 && !matched[0].querySelector('span.title')) {
    rawVal = extractFullText(matched[0]);
  }
  return rawVal;
}

export function extractFieldValue(
  root: Document | Element,
  rule: FieldSelectorRule,
): ExtractedFieldValue {
  let matched: Element[] = [];
  for (const selector of rule.selectors) {
    const found = queryAllSafe(root, selector);
    if (found.length > 0) {
      matched = found;
      break;
    }
  }
  if (matched.length === 0) {
    return null;
  }

  let rawVal: ExtractedFieldValue = null;

  switch (rule.extract) {
    case 'text':
      rawVal = extractDirectText(matched[0]);
      break;
    case 'full_text':
      rawVal = extractFullText(matched[0]);
      break;
    case 'rendered_text':
      rawVal = extractRenderedText(matched[0]);
      break;
    case 'attribute': {
      const attr = rule.attribute || 'href';
      rawVal = matched[0].getAttribute(attr) ?? '';
      break;
    }
    case 'list':
      rawVal = matched
        .map((el) => extractDirectText(el) || extractFullText(el))
        .filter((t) => t.length > 0);
      break;
    case 'sibling_text': {
      const parent = matched[0].parentElement;
      if (parent && rule.sibling_child_tag) {
        const siblings = queryAllSafe(parent, rule.sibling_child_tag);
        const texts = siblings.map(extractDirectText).filter((t) => t.length > 0);
        if (texts.length > 0) {
          rawVal = texts.join(rule.join_with || ' ');
        }
      }
      break;
    }
    case 'hourly_or_fixed_label': {
      const rateRaw = extractFullText(matched[0]);
      if (rateRaw.includes('Hourly')) {
        const strongEl = matched[0].querySelector('strong');
        rawVal = strongEl ? extractFullText(strongEl) : rateRaw.replace(/^Hourly:\s*/i, '').trim();
      } else if (rateRaw.includes('Fixed')) {
        rawVal = 'Fixed price';
      } else {
        rawVal = rateRaw;
      }
      break;
    }
    case 'ca_item_value': {
      rawVal = extractCaItemValue(matched, rule.label_contains);
      break;
    }
  }

  if (rawVal === null) {
    return null;
  }

  return applyTransforms(rawVal, rule.transforms);
}

export function extractViewFields(
  root: Document | Element,
  fields: Record<string, FieldSelectorRule>,
): Record<string, ExtractedFieldValue> {
  const out: Record<string, ExtractedFieldValue> = {};
  for (const [name, rule] of Object.entries(fields)) {
    out[name] = extractFieldValue(root, rule);
  }
  return out;
}

export function parseHtmlDocument(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

export function isJobNotFoundDocument(
  docOrHtml: Document | string,
  config: SelectorConfig = BUNDLED_SELECTORS,
): boolean {
  let doc: Document;
  if (typeof docOrHtml === 'string') {
    if (!docOrHtml.trim()) {
      return true;
    }
    doc = parseHtmlDocument(docOrHtml);
  } else {
    doc = docOrHtml;
  }

  const bodyHtml = doc.body?.innerHTML?.trim() ?? '';
  const titleText = (doc.title ?? '').trim();
  if (!bodyHtml && !titleText) {
    return true;
  }

  const guards = config.page_guards;
  const notFoundHeadings = (guards.not_found_headings ?? []).map((h) => h.toLowerCase());
  if (notFoundHeadings.length === 0) {
    return false;
  }

  const titleEl = doc.querySelector('title');
  const titleLower = (titleEl ? extractFullText(titleEl) : titleText).toLowerCase();
  if (titleLower && notFoundHeadings.some((h) => titleLower.includes(h))) {
    return true;
  }

  for (const sel of guards.error_heading_selectors ?? []) {
    const els = queryAllSafe(doc, sel);
    for (const el of els) {
      const headingLower = extractFullText(el).toLowerCase();
      if (headingLower && notFoundHeadings.some((h) => headingLower.includes(h))) {
        return true;
      }
    }
  }

  return false;
}

export function hasDetailSignals(
  root: Document | Element,
  description: string,
  config: SelectorConfig = BUNDLED_SELECTORS,
): boolean {
  if (description.trim().length > 0) {
    return true;
  }
  for (const sel of config.page_guards.detail_signal_selectors ?? []) {
    if (queryAllSafe(root, sel).length > 0) {
      return true;
    }
  }
  return false;
}

export function checkAuthAndChallengeGuards(
  doc: Document,
  loc: Pick<Location, 'href' | 'pathname'>,
  config: SelectorConfig = BUNDLED_SELECTORS,
): SessionProbeResult {
  const baseGuards = config.auth_and_challenge_guards;
  const pageGuards = config.page_guards;
  const effectiveGuards: AuthAndChallengeGuardsConfig = {
    ...baseGuards,
    challenge_selectors: [
      ...(baseGuards?.challenge_selectors ?? []),
      ...(pageGuards.challenge_selectors ?? []),
    ],
    logged_in_selectors: [
      ...(baseGuards?.logged_in_selectors ?? []),
      ...(pageGuards.auth_logged_in_selectors ?? []),
    ],
  };
  return detectChallengeOrAuth(doc, loc, effectiveGuards);
}

export async function resolveSelectorConfig(explicit?: SelectorConfig): Promise<SelectorConfig> {
  if (explicit) {
    return explicit;
  }
  return loadActiveSelectors();
}

export function parseJobListingsFromDocument(
  docOrHtml: Document | string,
  config: SelectorConfig = BUNDLED_SELECTORS,
  viewName = 'search_listings',
): ParsedJobRecord[] {
  const doc = typeof docOrHtml === 'string' ? parseHtmlDocument(docOrHtml) : docOrHtml;
  const viewCfg = config.views[viewName] ?? config.views.search_listings;
  if (!viewCfg) return [];

  let containers: Element[] = [];
  for (const sel of viewCfg.container_selectors ?? []) {
    const matched = queryAllSafe(doc, sel);
    if (matched.length > 0) {
      containers = matched;
      break;
    }
  }

  const results: ParsedJobRecord[] = [];
  for (const card of containers) {
    const extracted = extractViewFields(card, viewCfg.fields);
    const title = typeof extracted.title === 'string' ? extracted.title : '';
    if (!title) {
      continue;
    }

    const url = typeof extracted.url === 'string' ? extracted.url : '';
    let hourlyRate = typeof extracted.hourly_rate === 'string' ? extracted.hourly_rate : null;
    let budget = typeof extracted.budget === 'string' ? extracted.budget : null;
    if (hourlyRate === 'Fixed price') {
      if (!budget) {
        budget = 'Fixed price';
      }
      hourlyRate = null;
    }

    results.push({
      title,
      url,
      upwork_job_id: extractUpworkJobID(url),
      description: typeof extracted.description === 'string' ? extracted.description : '',
      budget,
      hourly_rate: hourlyRate,
      experience_level:
        typeof extracted.experience_level === 'string' ? extracted.experience_level : null,
      duration: typeof extracted.duration === 'string' ? extracted.duration : null,
      hours_per_week: null,
      skills: Array.isArray(extracted.skills) ? extracted.skills : [],
      posted: typeof extracted.posted === 'string' ? extracted.posted : null,
      country: typeof extracted.country === 'string' ? extracted.country : null,
      proposals: typeof extracted.proposals === 'string' ? extracted.proposals : null,
      client_rating: typeof extracted.client_rating === 'number' ? extracted.client_rating : null,
      client_reviews: null,
      client_spent: typeof extracted.client_spent === 'string' ? extracted.client_spent : null,
      client_hires: null,
      payment_verified:
        typeof extracted.payment_verified === 'string' ? extracted.payment_verified : null,
      client_hire_rate: null,
      connects_required: null,
      client_activity: [],
      screening_questions: [],
      attachments: [],
      qualifications: [],
    });
  }

  return results;
}

export function parseJobDetailFromDocument(
  docOrHtml: Document | string,
  config: SelectorConfig = BUNDLED_SELECTORS,
  url = '',
): ParsedJobRecord | null {
  const doc = typeof docOrHtml === 'string' ? parseHtmlDocument(docOrHtml) : docOrHtml;
  if (isJobNotFoundDocument(doc, config)) {
    return null;
  }

  const viewCfg = config.views.job_detail;
  if (!viewCfg) return null;

  const extracted = extractViewFields(doc, viewCfg.fields);
  const title = typeof extracted.title === 'string' ? extracted.title : '';
  if (!title) {
    return null;
  }

  const notFoundHeadings = (config.page_guards.not_found_headings ?? []).map((h) =>
    h.toLowerCase(),
  );
  const titleLower = title.toLowerCase();
  if (notFoundHeadings.some((h) => titleLower.includes(h))) {
    return null;
  }

  const description = typeof extracted.description === 'string' ? extracted.description : '';
  if (!hasDetailSignals(doc, description, config)) {
    return null;
  }

  const canonicalUrl = url ? normalizeJobUrl(url) : '';

  return {
    title,
    url: canonicalUrl,
    upwork_job_id: extractUpworkJobID(canonicalUrl),
    description,
    budget: typeof extracted.budget === 'string' ? extracted.budget : null,
    hourly_rate: typeof extracted.hourly_rate === 'string' ? extracted.hourly_rate : null,
    experience_level:
      typeof extracted.experience_level === 'string' ? extracted.experience_level : null,
    duration: typeof extracted.duration === 'string' ? extracted.duration : null,
    hours_per_week: typeof extracted.hours_per_week === 'string' ? extracted.hours_per_week : null,
    skills: Array.isArray(extracted.skills) ? extracted.skills : [],
    posted: typeof extracted.posted === 'string' ? extracted.posted : null,
    country: typeof extracted.country === 'string' ? extracted.country : null,
    proposals: typeof extracted.proposals === 'string' ? extracted.proposals : null,
    client_rating: typeof extracted.client_rating === 'number' ? extracted.client_rating : null,
    client_reviews: typeof extracted.client_reviews === 'string' ? extracted.client_reviews : null,
    client_spent: typeof extracted.client_spent === 'string' ? extracted.client_spent : null,
    client_hires: typeof extracted.client_hires === 'number' ? extracted.client_hires : null,
    payment_verified:
      typeof extracted.payment_verified === 'string' ? extracted.payment_verified : null,
    client_hire_rate:
      typeof extracted.client_hire_rate === 'string' ? extracted.client_hire_rate : null,
    connects_required:
      typeof extracted.connects_required === 'number' ? extracted.connects_required : null,
    client_activity: Array.isArray(extracted.client_activity) ? extracted.client_activity : [],
    screening_questions: Array.isArray(extracted.screening_questions)
      ? extracted.screening_questions
      : [],
    attachments: Array.isArray(extracted.attachments) ? extracted.attachments : [],
    qualifications: Array.isArray(extracted.qualifications) ? extracted.qualifications : [],
  };
}
