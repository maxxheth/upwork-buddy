import type {
  BrokenFieldDiagnosis,
  DiagnosticScope,
  DriftAuditReport,
  PassiveGraphqlSummary,
  PassiveTapPayload,
  PrunedLandmarkNode,
  RankedSelectorCandidate,
  RepetitivePatternCandidate,
  SelectorAuditEntry,
  SelectorHealthStatus,
  SelectorPatchFieldSummary,
  SelectorPatchRegression,
  SelectorPatchTestResult,
  UiDiagnosticCapture,
  UpWorkPageBlueprint,
} from '../shared/protocol';
import {
  BUNDLED_SELECTORS,
  type FieldSelectorRule,
  type SelectorConfig,
} from '../shared/selectors';
import {
  buildPageBlueprint,
  computeOverallAuditStatus,
  DriftAuditor,
  querySelectorAllSafe,
  resolveConfigViewName,
} from './adapters/drift-auditor';
import {
  extractFieldValue,
  extractFullText,
  parseHtmlDocument,
  queryAllSafe,
} from './selector-engine';

const MAX_PRUNED_HTML_BYTES = 256 * 1024;
const MAX_ANCHOR_HTML_BYTES = 8 * 1024;
const HIDDEN_TAG_ATTR = 'data-ub-prune-hidden';

const STRIP_DIAGNOSTIC_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'canvas',
  'embed',
  'object',
  'param',
  'track',
]);

const LANDMARK_TAGS = new Set(['header', 'nav', 'main', 'section', 'article', 'aside', 'footer']);
const NON_REPEATABLE_LANDMARKS = new Set(['header', 'nav', 'main', 'section', 'aside', 'footer']);

const UTILITY_CLASS_RE =
  /^(?:data-v|p|m|px|py|pt|pb|pl|pr|mx|my|mt|mb|ml|mr|w|h|max-w|min-w|max-h|min-h|text|bg|border|rounded|gap|space|d|flex|grid|align|justify|items|self|col|row|fs|fw|lh|opacity|shadow|overflow|position|top|right|bottom|left|z)-/i;

const TRACKER_HOSTS = [
  'doubleclick.net',
  'google-analytics.com',
  'googletagmanager.com',
  'googleadservices.com',
  'googlesyndication.com',
  'bat.bing.com',
  'clarity.ms',
  'hotjar.com',
  'hotjar.io',
  'analytics.twitter.com',
  'px.ads.linkedin.com',
  'ads.linkedin.com',
  'snap.licdn.com',
  'segment.io',
  'mixpanel.com',
  'scorecardresearch.com',
  'quantserve.com',
  'adsrvr.org',
];

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;

const FIELD_KEYWORD_HINTS: Record<string, string[]> = {
  title: ['title', 'headline', 'job-title', 'job details'],
  description: ['description', 'summary', 'job description'],
  skills: [
    'skill',
    'skills',
    'skills and expertise',
    'expertise',
    'mandatory',
    'preferred',
    'token',
    'badge',
  ],
  budget: ['budget', 'fixed-price', 'fixed price', 'est. budget', 'price'],
  hourly_rate: ['hourly', 'clock-timelog', 'rate', 'timelog'],
  experience_level: ['experience', 'expertise', 'entry level', 'intermediate', 'expert', 'tier'],
  duration: ['duration', 'project length', 'est. time', 'months', 'weeks'],
  hours_per_week: ['hours per week', 'hrs/week', 'clock-hourly', 'less than', 'more than'],
  proposals: ['activity on this job', 'proposals', 'client-activity', 'interviewing', 'invites'],
  connects_required: ['connects', 'send a proposal', 'required connects'],
  client_activity: ['activity on this job', 'interviewing', 'invites sent', 'unanswered'],
  client_rating: ['rating', 'feedback', 'reviews', 'about the client'],
  client_reviews: ['reviews', 'rating', 'about the client'],
  client_spent: ['spent', 'total spent', 'about the client'],
  client_hires: ['hires', 'about the client'],
  client_hire_rate: ['hire rate', 'jobs posted', 'about the client'],
  payment_verified: ['payment verified', 'payment method', 'about the client'],
  country: ['location', 'country', 'about the client'],
  screening_questions: ['question', 'screening', 'questions for freelancer'],
  attachments: ['attachment', 'attachments', 'files'],
  qualifications: ['qualification', 'preferred qualifications'],
  cover_letter: ['cover letter', 'proposal'],
  composer_input: ['write a message', 'composer', 'message'],
  send_button: ['send'],
};

const SENSITIVE_PII_VIEWS = new Set([
  'messages_rooms',
  'messages_thread',
  'proposal_apply',
  'proposals_list',
]);

function collapsedText(el: Element | null | undefined): string {
  if (!el) return '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function isTinyDim(val: string | null): boolean {
  if (!val) return false;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i.exec(val);
  return Boolean(m && Number.parseFloat(m[1]) <= 2);
}

function isTrackerImg(el: Element): boolean {
  if (el.tagName.toLowerCase() !== 'img') return false;
  const w = el.getAttribute('width');
  const h = el.getAttribute('height');
  const declared = [w, h].filter((x): x is string => Boolean(x?.trim()));
  if (declared.length > 0 && declared.every((d) => isTinyDim(d))) {
    return true;
  }
  const src = el.getAttribute('src') ?? '';
  if (!src.startsWith('http') && !src.startsWith('//')) {
    return false;
  }
  try {
    const parsed = new URL(src, 'https://www.upwork.com');
    const host = parsed.hostname.toLowerCase();
    return TRACKER_HOSTS.some((th) => host === th || host.endsWith(`.${th}`));
  } catch {
    return false;
  }
}

function isUpworkBuddyOverlayElement(el: Element): boolean {
  const id = el.getAttribute('id') ?? '';
  const tag = el.tagName.toLowerCase();
  if (tag === 'upwork-buddy-ui') return true;
  if (id.startsWith('upwork-buddy-')) return true;
  if (el.hasAttribute('data-upwork-buddy-ignore')) return true;
  return false;
}

function resolveScopeRoot(
  doc: Document,
  scope: DiagnosticScope,
): { rootEl: Element; resolvedScope: DiagnosticScope } {
  if (scope === 'drawer') {
    const drawer = doc.querySelector('.job-details-content');
    if (drawer) return { rootEl: drawer, resolvedScope: 'drawer' };
  }
  if (scope === 'auto') {
    const drawer = doc.querySelector('.job-details-content');
    if (drawer) return { rootEl: drawer, resolvedScope: 'drawer' };
    const main = doc.querySelector('main');
    if (main) return { rootEl: main, resolvedScope: 'page' };
  }
  if (scope === 'page') {
    const main = doc.querySelector('main');
    if (main) return { rootEl: main, resolvedScope: 'page' };
  }
  return {
    rootEl: doc.body ?? doc.documentElement,
    resolvedScope: scope === 'drawer' ? 'drawer' : 'page',
  };
}

function isElementInvisible(el: Element, hasRealLayout: boolean): boolean {
  if (isUpworkBuddyOverlayElement(el)) return true;
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') {
    return true;
  }
  const htmlEl = el as HTMLElement;
  if (htmlEl.style && (htmlEl.style.display === 'none' || htmlEl.style.visibility === 'hidden')) {
    return true;
  }
  const view = el.ownerDocument?.defaultView;
  if (view && typeof view.getComputedStyle === 'function') {
    try {
      const cs = view.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') {
        return true;
      }
      if (
        hasRealLayout &&
        cs.display !== 'contents' &&
        el.tagName.toLowerCase() !== 'option' &&
        typeof el.getBoundingClientRect === 'function'
      ) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          return true;
        }
      }
    } catch {
      // ignore getComputedStyle issues in non-DOM contexts
    }
  }
  return false;
}

function stripComments(root: Element): void {
  const doc = root.ownerDocument;
  if (!doc || typeof doc.createTreeWalker !== 'function') return;
  const walker = doc.createTreeWalker(root, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments: Node[] = [];
  let curr = walker.nextNode();
  while (curr) {
    comments.push(curr);
    curr = walker.nextNode();
  }
  for (const c of comments) {
    c.parentNode?.removeChild(c);
  }
}

export function cleanElementClasses(classAttr: string | null): string[] {
  if (!classAttr) return [];
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const token of classAttr.trim().split(/\s+/)) {
    if (!token || UTILITY_CLASS_RE.test(token) || seen.has(token)) continue;
    seen.add(token);
    kept.push(token);
  }
  return kept;
}

function sanitizeHref(rawHref: string): string {
  const trimmed = rawHref.trim();
  if (!trimmed) return '';
  if (/^javascript:/i.test(trimmed)) return '';
  try {
    const u = new URL(trimmed, 'https://www.upwork.com');
    const paramKeys = Array.from(new Set(u.searchParams.keys()));
    return paramKeys.length > 0 ? `${u.pathname}?keys=${paramKeys.join(',')}` : u.pathname;
  } catch {
    return trimmed.split(/[?#]/)[0] ?? '';
  }
}

function scrubSensitiveString(text: string): string {
  return text
    .replace(EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(JWT_RE, '[REDACTED_JWT]')
    .replace(BEARER_RE, 'Bearer [REDACTED_TOKEN]');
}

export function sanitizeCaptureDom(
  root: Element,
  opts: { redactPii: boolean; viewType: string },
): void {
  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of all) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const inputType = (el.getAttribute('type') ?? 'text').toLowerCase();
      const inputName = (el.getAttribute('name') ?? '').toLowerCase();
      if (
        inputType === 'password' ||
        inputName.includes('token') ||
        inputName.includes('secret') ||
        inputName.includes('auth')
      ) {
        el.removeAttribute('value');
      } else if (opts.redactPii && el.hasAttribute('value')) {
        const val = el.getAttribute('value') ?? '';
        el.setAttribute('value', scrubSensitiveString(val));
      }
    }

    if (el.hasAttribute('href')) {
      const sanitized = sanitizeHref(el.getAttribute('href') ?? '');
      if (sanitized) {
        el.setAttribute('href', sanitized);
      } else {
        el.removeAttribute('href');
      }
    }

    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('data-v-')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (attr.name === 'style') {
        el.removeAttribute('style');
        continue;
      }
      if (attr.name === 'class') {
        const kept = cleanElementClasses(attr.value);
        if (kept.length > 0) {
          el.setAttribute('class', kept.join(' '));
        } else {
          el.removeAttribute('class');
        }
        continue;
      }
      if (attr.name === 'title' || attr.name === 'aria-label' || attr.name === 'placeholder') {
        el.setAttribute(attr.name, scrubSensitiveString(attr.value));
      }
    }
  }

  // Scrub emails / tokens in text nodes
  const doc = root.ownerDocument;
  if (doc && typeof doc.createTreeWalker === 'function') {
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    let node = walker.nextNode();
    while (node) {
      if (node.nodeValue) {
        node.nodeValue = scrubSensitiveString(node.nodeValue);
      }
      node = walker.nextNode();
    }
  }

  // Mask private client names, message bodies, and draft text on sensitive views
  if (opts.redactPii && SENSITIVE_PII_VIEWS.has(opts.viewType)) {
    const piiSelectors = [
      '.message-body',
      "[data-test='message-body']",
      '.story-message',
      "[data-test='last-message']",
      "[data-test='room-last-message']",
      '.room-preview',
      "[data-test='room-name']",
      '.room-title',
      "[data-test='message-sender']",
      '.story-author',
      'textarea',
    ];
    for (const el of querySelectorAllSafe(root, piiSelectors.join(', '))) {
      const len = collapsedText(el).length;
      if (len > 0) {
        el.textContent = `[REDACTED_TEXT len=${len}]`;
      }
    }
  }
}

export function truncateHtmlSafely(html: string, maxBytes: number): string {
  if (html.length <= maxBytes) return html;
  const sliced = html.slice(0, maxBytes);
  const lastClose = sliced.lastIndexOf('>');
  if (lastClose > Math.floor(maxBytes * 0.5)) {
    return `${sliced.slice(0, lastClose + 1)}\n<!-- truncated -->`;
  }
  return `${sliced}\n<!-- truncated -->`;
}

export function pruneDomForDiagnostics(
  liveRoot: Element,
  opts: { redactPii?: boolean; viewType?: string } = {},
): Element {
  const redactPii = opts.redactPii !== false;
  const viewType = opts.viewType ?? 'unknown';

  const docRect = liveRoot.ownerDocument?.documentElement?.getBoundingClientRect?.();
  const hasRealLayout = Boolean(docRect && docRect.width > 0 && docRect.height > 0);

  const tagged: Element[] = [];
  const candidates = [liveRoot, ...Array.from(liveRoot.querySelectorAll('*'))];
  for (const el of candidates) {
    if (el !== liveRoot && isElementInvisible(el, hasRealLayout)) {
      el.setAttribute(HIDDEN_TAG_ATTR, '1');
      tagged.push(el);
    }
  }

  let clone: Element;
  try {
    clone = liveRoot.cloneNode(true) as Element;
  } finally {
    for (const el of tagged) {
      el.removeAttribute(HIDDEN_TAG_ATTR);
    }
  }

  for (const hiddenEl of querySelectorAllSafe(clone, `[${HIDDEN_TAG_ATTR}]`)) {
    hiddenEl.remove();
  }

  for (const tag of STRIP_DIAGNOSTIC_TAGS) {
    for (const node of querySelectorAllSafe(clone, tag)) {
      node.remove();
    }
  }

  for (const img of querySelectorAllSafe(clone, 'img')) {
    if (isTrackerImg(img)) {
      img.remove();
    }
  }

  stripComments(clone);
  sanitizeCaptureDom(clone, { redactPii, viewType });
  return clone;
}

function getElementSignature(el: Element): string {
  const parts: string[] = [];
  for (const child of Array.from(el.children)) {
    const grandChildren = Array.from(child.children).map((g) => g.tagName.toLowerCase());
    parts.push(`${child.tagName.toLowerCase()}(${grandChildren.join(',')})`);
  }
  return `${el.tagName.toLowerCase()}:[${parts.join(',')}]`;
}

function buildStableSelectorSegment(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const dt = el.getAttribute('data-test')?.trim();
  if (dt) return `[data-test='${dt}']`;
  const dqa = el.getAttribute('data-qa')?.trim();
  if (dqa) return `[data-qa='${dqa}']`;
  const dcy = el.getAttribute('data-cy')?.trim();
  if (dcy) return `[data-cy='${dcy}']`;
  const id = el.getAttribute('id')?.trim();
  if (id && !/\d{4,}/.test(id)) return `#${id}`;
  const classes = cleanElementClasses(el.getAttribute('class'));
  const semantic = classes.find((c) => !c.startsWith('col-') && !c.startsWith('row'));
  if (semantic) return `${tag}.${semantic}`;
  return tag;
}

function buildContainerSelector(el: Element, root: Element): string {
  const parts: string[] = [];
  let curr: Element | null = el;
  while (curr && curr !== root && parts.length < 3) {
    const seg = buildStableSelectorSegment(curr);
    parts.unshift(seg);
    if (seg.startsWith('[data-') || seg.startsWith('#')) {
      break;
    }
    curr = curr.parentElement;
  }
  return parts.join(' > ') || el.tagName.toLowerCase();
}

function findNearestHeading(el: Element, root: Element): string | null {
  const headingSel = 'h1, h2, h3, h4, h5, h6, [data-test*="heading"], .air3-card-section > header';
  const inside = el.querySelector(headingSel);
  if (inside) {
    const t = collapsedText(inside);
    if (t) return t.slice(0, 80);
  }
  let curr: Element | null = el;
  while (curr && curr !== root.parentElement) {
    let prev = curr.previousElementSibling;
    while (prev) {
      if (prev.matches?.(headingSel)) {
        const t = collapsedText(prev);
        if (t) return t.slice(0, 80);
      }
      const nestedHeading = prev.querySelector(headingSel);
      if (nestedHeading) {
        const t = collapsedText(nestedHeading);
        if (t) return t.slice(0, 80);
      }
      prev = prev.previousElementSibling;
    }
    const ownHeading = Array.from(curr.children).find((c) => c.matches?.(headingSel));
    if (ownHeading) {
      const t = collapsedText(ownHeading);
      if (t) return t.slice(0, 80);
    }
    curr = curr.parentElement;
  }
  return null;
}

function inferPatternName(first: Element, heading: string | null): string {
  const combined =
    `${heading ?? ''} ${first.getAttribute('class') ?? ''} ${first.getAttribute('data-test') ?? ''}`.toLowerCase();
  if (combined.includes('skill') || combined.includes('token')) return 'SkillBadgeList';
  if (combined.includes('job-tile') || combined.includes('jobtile')) return 'JobTileCard';
  if (combined.includes('activity') || combined.includes('ca-item')) return 'ActivityList';
  if (combined.includes('question')) return 'ScreeningQuestionList';
  if (combined.includes('qualification')) return 'QualificationList';
  if (combined.includes('room')) return 'MessageRoomList';
  if (combined.includes('message') || combined.includes('story')) return 'MessageItemList';
  if (first.tagName.toLowerCase() === 'li') return 'ListItemGroup';
  return 'RepeatedPattern';
}

function deriveRepeatedItemSelector(containerSelector: string, cluster: Element[]): string {
  const first = cluster[0];
  const tag = first.tagName.toLowerCase();
  const commonDataTests = cluster.map((el) => el.getAttribute('data-test') ?? '').filter(Boolean);
  if (commonDataTests.length === cluster.length && new Set(commonDataTests).size === 1) {
    return `${containerSelector} [data-test='${commonDataTests[0]}']`;
  }

  const classSets = cluster.map((el) => new Set(cleanElementClasses(el.getAttribute('class'))));
  const firstClasses = Array.from(classSets[0] ?? []);
  const sharedClass = firstClasses.find(
    (cls) =>
      (cls.startsWith('air3-') ||
        cls.includes('skill') ||
        cls.includes('badge') ||
        cls.includes('token') ||
        cls.includes('item') ||
        cls.includes('card')) &&
      classSets.every((set) => set.has(cls)),
  );
  if (sharedClass) {
    return `${containerSelector} ${tag}.${sharedClass}`;
  }
  if (firstClasses[0] && classSets.every((set) => set.has(firstClasses[0]))) {
    return `${containerSelector} ${tag}.${firstClasses[0]}`;
  }
  return `${containerSelector} > ${tag}`;
}

export function detectRepetitivePatterns(root: Element): RepetitivePatternCandidate[] {
  const candidates = [
    root,
    ...Array.from(root.querySelectorAll('ul, ol, div, section, aside, main')),
  ];
  const patterns: RepetitivePatternCandidate[] = [];
  const seenKeys = new Set<string>();

  for (const container of candidates) {
    const children = Array.from(container.children).filter(
      (c) => !NON_REPEATABLE_LANDMARKS.has(c.tagName.toLowerCase()),
    );
    const heading = findNearestHeading(container, root);
    const minGroupSize = heading ? 2 : 3;
    if (children.length < minGroupSize) continue;

    const groups = new Map<string, Element[]>();
    for (const child of children) {
      const sig = getElementSignature(child);
      const bucket = groups.get(sig) ?? [];
      bucket.push(child);
      groups.set(sig, bucket);
    }

    for (const group of groups.values()) {
      if (group.length < minGroupSize) continue;
      // Avoid tiny non-text icon groups
      const samples = group
        .map((g) => collapsedText(g))
        .filter((t) => t.length > 0 && t.length <= 140);
      if (samples.length < minGroupSize) continue;

      const containerSelector = buildContainerSelector(container, root);
      const itemSelector = deriveRepeatedItemSelector(containerSelector, group);
      const dedupKey = `${itemSelector}:${group.length}`;
      if (seenKeys.has(dedupKey)) continue;
      seenKeys.add(dedupKey);

      patterns.push({
        pattern_name: inferPatternName(group[0], heading),
        nearest_heading: heading,
        container_selector: containerSelector,
        item_selector: itemSelector,
        instance_count: group.length,
        sample_items: samples.slice(0, 5),
      });
    }
  }

  return patterns.sort((a, b) => b.instance_count - a.instance_count).slice(0, 20);
}

function textPreview(el: Element, maxWords = 25): string {
  const words = collapsedText(el).split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}...`;
}

export function buildPrunedLandmarks(root: Element, maxDepth = 4): PrunedLandmarkNode[] {
  const walk = (el: Element, depth: number): PrunedLandmarkNode[] => {
    if (depth > maxDepth) return [];
    const results: PrunedLandmarkNode[] = [];
    for (const child of Array.from(el.children)) {
      const tag = child.tagName.toLowerCase();
      if (LANDMARK_TAGS.has(tag)) {
        const directPatterns = detectRepetitivePatterns(child).slice(0, 5);
        results.push({
          landmark: tag,
          tag,
          id: child.getAttribute('id'),
          data_test: child.getAttribute('data-test'),
          classes: cleanElementClasses(child.getAttribute('class')).slice(0, 5),
          text_preview: textPreview(child, 25),
          child_count: child.children.length,
          patterns: directPatterns,
          children: walk(child, depth + 1),
        });
      } else {
        results.push(...walk(child, depth));
      }
    }
    return results;
  };

  if (LANDMARK_TAGS.has(root.tagName.toLowerCase())) {
    const tag = root.tagName.toLowerCase();
    return [
      {
        landmark: tag,
        tag,
        id: root.getAttribute('id'),
        data_test: root.getAttribute('data-test'),
        classes: cleanElementClasses(root.getAttribute('class')).slice(0, 5),
        text_preview: textPreview(root, 25),
        child_count: root.children.length,
        patterns: detectRepetitivePatterns(root).slice(0, 5),
        children: walk(root, 1),
      },
    ];
  }
  return walk(root, 0);
}

function normalizeFieldKey(field: string): string {
  switch (field) {
    case 'experienceLevel':
      return 'experience_level';
    case 'budgetRow':
      return 'budget';
    case 'hourlyRate':
      return 'hourly_rate';
    default:
      return field;
  }
}

function scoreCandidateStability(selector: string, isFragile: boolean): number {
  let score = 50;
  if (/\[data-(?:test|qa|cy|testid)[*^$]?=/i.test(selector)) score += 40;
  if (/\[aria-label(?:ledby)?[*^$]?=/i.test(selector)) score += 25;
  if (/\.(?:air3-|skills-|job-|ca-|badge|token)/i.test(selector)) score += 18;
  if (selector.includes(' > ') || selector.includes(' ')) score += 8;
  if (isFragile || /data-v-/.test(selector)) score -= 60;
  if (/:nth-child/i.test(selector)) score -= 20;
  if (/^[a-z0-9]+$/i.test(selector.trim())) score -= 30;
  return score;
}

function findAnchorElementForField(
  prunedRoot: Element,
  field: string,
): { anchor: Element; heading: string | null } {
  const normField = normalizeFieldKey(field);
  const hints = FIELD_KEYWORD_HINTS[normField] ?? [normField.replace(/_/g, ' ')];

  const candidateSections = [
    ...querySelectorAllSafe(
      prunedRoot,
      'section, article, aside, .air3-card-section, [data-test], ul, div',
    ),
  ];

  let bestScore = -1;
  let bestAnchor: Element = prunedRoot;
  let bestHeading: string | null = null;

  for (const el of candidateSections) {
    const htmlLen = el.outerHTML.length;
    if (el !== prunedRoot && htmlLen > 32_000) continue; // avoid grabbing the entire page wrapper

    const dt = (el.getAttribute('data-test') ?? '').toLowerCase();
    const dqa = (el.getAttribute('data-qa') ?? '').toLowerCase();
    const cls = (el.getAttribute('class') ?? '').toLowerCase();
    const heading = findNearestHeading(el, prunedRoot);
    const headingLower = (heading ?? '').toLowerCase();
    const previewLower = collapsedText(el).slice(0, 200).toLowerCase();

    let score = 0;
    for (const h of hints) {
      if (dt.includes(h) || dqa.includes(h)) score += 45;
      if (cls.includes(h)) score += 30;
      if (headingLower.includes(h)) score += 35;
      if (previewLower.includes(h)) score += 15;
    }

    // Prefer tighter sections when tied
    if (score > 0 && htmlLen < 6000) {
      score += 10;
    }

    if (score > bestScore) {
      bestScore = score;
      bestAnchor = el;
      bestHeading = heading;
    }
  }

  return { anchor: bestAnchor, heading: bestHeading };
}

function synthesizeCandidatesForField(
  field: string,
  liveRoot: Element,
  prunedRoot: Element,
  anchor: Element,
  patterns: RepetitivePatternCandidate[],
  existingRule?: FieldSelectorRule,
): RankedSelectorCandidate[] {
  const normField = normalizeFieldKey(field);
  const hints = FIELD_KEYWORD_HINTS[normField] ?? [normField.replace(/_/g, ' ')];
  const candidateSpecs: Array<{ selector: string; strategy: string }> = [];
  const seen = new Set<string>();

  const pushCandidate = (selector: string, strategy: string): void => {
    const trimmed = selector.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidateSpecs.push({ selector: trimmed, strategy });
  };

  // 1. Repetitive sibling patterns matching field hints or inside anchor
  const anchorSelector = buildContainerSelector(anchor, prunedRoot);
  for (const pat of patterns) {
    const patText =
      `${pat.pattern_name} ${pat.nearest_heading ?? ''} ${pat.container_selector} ${pat.item_selector}`.toLowerCase();
    if (hints.some((h) => patText.includes(h)) || pat.container_selector === anchorSelector) {
      pushCandidate(pat.item_selector, 'repetitive_pattern');
      pushCandidate(`${pat.item_selector} .air3-line-clamp`, 'repetitive_pattern_leaf');
      pushCandidate(`${pat.item_selector} span`, 'repetitive_pattern_leaf');
    }
  }

  // 2. Attribute hooks inside the anchor
  const anchorHooks = [anchor, ...Array.from(anchor.querySelectorAll('*'))];
  for (const el of anchorHooks) {
    const tag = el.tagName.toLowerCase();
    for (const attrName of ['data-test', 'data-qa', 'data-cy', 'data-testid']) {
      const val = el.getAttribute(attrName)?.trim();
      if (!val) continue;
      const base = `[${attrName}='${val}']`;
      pushCandidate(base, 'anchor_hook');
      if (normField === 'skills') {
        pushCandidate(`${base} .air3-line-clamp`, 'anchor_hook_leaf');
        pushCandidate(`${base} a`, 'anchor_hook_leaf');
        pushCandidate(`${base} span`, 'anchor_hook_leaf');
      } else if (tag !== 'input' && tag !== 'textarea') {
        pushCandidate(`${base} strong`, 'anchor_hook_leaf');
      }
    }
    const aria = el.getAttribute('aria-label')?.trim();
    if (aria && hints.some((h) => aria.toLowerCase().includes(h))) {
      pushCandidate(`${tag}[aria-label='${aria}']`, 'aria_label');
    }
    for (const cls of cleanElementClasses(el.getAttribute('class'))) {
      if (
        cls.startsWith('air3-') ||
        cls.includes('skill') ||
        cls.includes('badge') ||
        cls.includes('token')
      ) {
        if (anchorSelector && anchor !== prunedRoot) {
          pushCandidate(`${anchorSelector} .${cls}`, 'anchor_semantic_class');
        }
        pushCandidate(`.${cls}`, 'semantic_class');
      }
    }
  }

  // 3. Existing fallback selectors from rule
  if (existingRule) {
    for (const sel of existingRule.selectors) {
      pushCandidate(sel, 'existing_rule');
    }
  }

  const extractMode: FieldSelectorRule['extract'] =
    existingRule?.extract ?? (normField === 'skills' ? 'list' : 'full_text');

  const evaluated: RankedSelectorCandidate[] = [];
  for (const spec of candidateSpecs.slice(0, 30)) {
    const matchedEls = queryAllSafe(liveRoot, spec.selector);
    if (matchedEls.length === 0) continue;

    const testRule: FieldSelectorRule = {
      selectors: [spec.selector],
      extract: extractMode,
      ...(existingRule?.attribute ? { attribute: existingRule.attribute } : {}),
      ...(existingRule?.transforms ? { transforms: existingRule.transforms } : {}),
      ...(existingRule?.sibling_child_tag
        ? { sibling_child_tag: existingRule.sibling_child_tag }
        : {}),
      ...(existingRule?.join_with ? { join_with: existingRule.join_with } : {}),
      ...(existingRule?.label_contains ? { label_contains: existingRule.label_contains } : {}),
    };
    const sampleVal = extractFieldValue(liveRoot, testRule);
    const hasSample = Array.isArray(sampleVal)
      ? sampleVal.length > 0
      : sampleVal !== null && String(sampleVal).trim() !== '';
    if (!hasSample) continue;

    const isFragile = /data-v-/.test(spec.selector);
    const stability = scoreCandidateStability(spec.selector, isFragile);
    evaluated.push({
      selector: spec.selector,
      stability_score: stability,
      matched_count: matchedEls.length,
      sample_value: Array.isArray(sampleVal) ? sampleVal.slice(0, 8) : sampleVal,
      strategy: spec.strategy,
      is_fragile: isFragile,
      reason: `Matched ${matchedEls.length} node(s) via ${spec.strategy}`,
    });
  }

  return evaluated
    .sort((a, b) => {
      if (a.is_fragile !== b.is_fragile) return a.is_fragile ? 1 : -1;
      if (b.stability_score !== a.stability_score) return b.stability_score - a.stability_score;
      return b.matched_count - a.matched_count;
    })
    .slice(0, 8);
}

export function diagnoseBrokenFields(
  liveRoot: Element,
  prunedRoot: Element,
  report: DriftAuditReport,
  selectorConfig: SelectorConfig,
  patterns: RepetitivePatternCandidate[],
  extraBrokenFields: string[] = [],
): BrokenFieldDiagnosis[] {
  const failingAudits: SelectorAuditEntry[] = report.audits.filter(
    (a) => a.status === 'BROKEN' || a.status === 'DEGRADED' || a.status === 'FRAGILE',
  );

  const seenFields = new Set(failingAudits.map((a) => normalizeFieldKey(a.target_field)));
  for (const rawField of extraBrokenFields) {
    const norm = normalizeFieldKey(rawField);
    if (!seenFields.has(norm)) {
      seenFields.add(norm);
      const existingRule = selectorConfig.views[report.view_type]?.fields?.[norm];
      failingAudits.push({
        target_field: norm,
        view: report.view_type,
        registered_selector: existingRule?.selectors?.[0] ?? '',
        status: 'BROKEN',
        matched_count: 0,
        sample_extracted_value: null,
        notes: `Reported failing by in-page extractor (${rawField})`,
        suggested_replacement: null,
      });
    }
  }

  return failingAudits.map((entry) => {
    const field = normalizeFieldKey(entry.target_field);
    const viewCfg = selectorConfig.views[entry.view] ?? selectorConfig.views[report.view_type];
    const existingRule = viewCfg?.fields?.[field];
    const { anchor, heading } = findAnchorElementForField(prunedRoot, field);
    const anchorHtml = truncateHtmlSafely(anchor.outerHTML, MAX_ANCHOR_HTML_BYTES);
    const candidates = synthesizeCandidatesForField(
      field,
      liveRoot,
      prunedRoot,
      anchor,
      patterns,
      existingRule,
    );

    return {
      field,
      view: entry.view,
      status: entry.status,
      registered_selector: entry.registered_selector,
      matched_count: entry.matched_count,
      notes: entry.notes,
      nearest_heading: heading,
      anchor_html: anchorHtml,
      candidates,
    };
  });
}

function summarizePassivePayloads(payloads: PassiveTapPayload[] = []): PassiveGraphqlSummary[] {
  const summaries: PassiveGraphqlSummary[] = [];
  const seen = new Set<string>();
  for (const p of payloads) {
    const op = p.operationName?.trim() || p.kind;
    let urlPath = p.url;
    try {
      urlPath = new URL(p.url, 'https://www.upwork.com').pathname;
    } catch {
      // keep raw
    }
    const key = `${op}:${urlPath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const topKeys =
      p.data && typeof p.data === 'object' && !Array.isArray(p.data)
        ? Object.keys(p.data as Record<string, unknown>).slice(0, 15)
        : [];

    summaries.push({
      operation_name: op,
      url: urlPath,
      top_keys: topKeys,
    });
    if (summaries.length >= 15) break;
  }
  return summaries;
}

export function captureUiDiagnostic(
  docOrHtml: Document | string,
  opts: {
    url?: string;
    title?: string;
    view?: string;
    scope?: DiagnosticScope;
    redactPii?: boolean;
    brokenFields?: string[];
    selectorConfig?: SelectorConfig;
    baseline?: UpWorkPageBlueprint | null;
    isAuthenticated?: boolean;
    passivePayloads?: PassiveTapPayload[];
  } = {},
): UiDiagnosticCapture {
  const doc = typeof docOrHtml === 'string' ? parseHtmlDocument(docOrHtml) : docOrHtml;
  const selectorConfig = opts.selectorConfig ?? BUNDLED_SELECTORS;
  const url = opts.url ?? doc.location?.href ?? 'https://www.upwork.com/';
  const title = opts.title ?? doc.title ?? '';
  const redactPii = opts.redactPii !== false;

  const { rootEl, resolvedScope } = resolveScopeRoot(doc, opts.scope ?? 'auto');
  const effectiveView = opts.view || (resolvedScope === 'drawer' ? 'job_detail' : undefined);

  const blueprint = buildPageBlueprint(doc, {
    url,
    title,
    isAuthenticated: opts.isAuthenticated,
    capturedXhrEndpoints: (opts.passivePayloads ?? []).map((p) => p.url),
  });

  const auditReport = new DriftAuditor(
    blueprint,
    rootEl,
    selectorConfig,
    opts.baseline ?? null,
  ).audit(effectiveView);

  const prunedRoot = pruneDomForDiagnostics(rootEl, {
    redactPii,
    viewType: auditReport.view_type,
  });

  const repetitivePatterns = detectRepetitivePatterns(prunedRoot);
  const landmarks = buildPrunedLandmarks(prunedRoot);
  const brokenFields = diagnoseBrokenFields(
    rootEl,
    prunedRoot,
    auditReport,
    selectorConfig,
    repetitivePatterns,
    opts.brokenFields ?? [],
  );

  const prunedHtml = truncateHtmlSafely(prunedRoot.outerHTML, MAX_PRUNED_HTML_BYTES);

  return {
    captured_at: new Date().toISOString(),
    url,
    title: scrubSensitiveString(title),
    view_type: auditReport.view_type,
    scope: resolvedScope,
    is_authenticated: opts.isAuthenticated ?? blueprint.is_authenticated,
    overall_status: computeOverallAuditStatus(auditReport),
    redact_pii: redactPii,
    audit_report: auditReport,
    blueprint,
    landmarks,
    repetitive_patterns: repetitivePatterns,
    broken_fields: brokenFields,
    pruned_html: prunedHtml,
    passive_graphql_ops: summarizePassivePayloads(opts.passivePayloads),
  };
}

const STATUS_SEVERITY: Record<SelectorHealthStatus, number> = {
  HEALTHY: 0,
  FRAGILE: 1,
  DEGRADED: 2,
  BROKEN: 3,
};

function summarizeField(
  root: Document | Element,
  rule: FieldSelectorRule,
  auditEntry?: SelectorAuditEntry,
): SelectorPatchFieldSummary {
  const val = extractFieldValue(root, rule);
  let matchedCount = auditEntry?.matched_count ?? 0;
  let matchedSelector: string | null = null;
  for (const sel of rule.selectors) {
    const found = queryAllSafe(root, sel);
    if (found.length > 0) {
      matchedSelector = sel;
      matchedCount = Math.max(matchedCount, found.length);
      break;
    }
  }
  return {
    status: auditEntry?.status ?? (matchedSelector ? 'HEALTHY' : 'BROKEN'),
    matched_count: matchedCount,
    sample_value: Array.isArray(val) ? val.slice(0, 10) : val,
    matched_selector: matchedSelector,
  };
}

export function testSelectorPatchOnDocument(
  docOrHtml: Document | Element | string,
  selectorConfig: SelectorConfig,
  view: string,
  field: string,
  proposedRule: FieldSelectorRule,
  url = 'https://www.upwork.com/',
): SelectorPatchTestResult {
  const root: Document | Element =
    typeof docOrHtml === 'string' ? parseHtmlDocument(docOrHtml) : docOrHtml;
  const rootEl: Element =
    'documentElement' in root
      ? ((root as Document).documentElement ?? (root as Document).body)
      : (root as Element);

  const blueprint = buildPageBlueprint(
    'documentElement' in root ? (root as Document) : rootEl.ownerDocument,
    {
      url,
      isAuthenticated: true,
    },
  );
  const targetView = resolveConfigViewName(view, blueprint.view_type, rootEl, url);
  const existingViewCfg = selectorConfig.views[targetView];

  const beforeReport = new DriftAuditor(blueprint, rootEl, selectorConfig, null).audit(targetView);
  const beforeAudit = beforeReport.audits.find(
    (a) => normalizeFieldKey(a.target_field) === normalizeFieldKey(field),
  );
  const existingRule = existingViewCfg?.fields?.[field] ?? proposedRule;
  const beforeSummary = summarizeField(rootEl, existingRule, beforeAudit);

  const patchedConfig: SelectorConfig = {
    ...selectorConfig,
    views: {
      ...selectorConfig.views,
      [targetView]: {
        ...(existingViewCfg ?? { fields: {} }),
        fields: {
          ...(existingViewCfg?.fields ?? {}),
          [field]: proposedRule,
        },
      },
    },
  };

  const afterReport = new DriftAuditor(blueprint, rootEl, patchedConfig, null).audit(targetView);
  const afterAudit = afterReport.audits.find(
    (a) => normalizeFieldKey(a.target_field) === normalizeFieldKey(field),
  );
  const afterSummary = summarizeField(rootEl, proposedRule, afterAudit);

  const beforeByField = new Map<string, SelectorAuditEntry>();
  for (const a of beforeReport.audits) {
    beforeByField.set(a.target_field, a);
  }

  const regressions: SelectorPatchRegression[] = [];
  for (const a of afterReport.audits) {
    if (normalizeFieldKey(a.target_field) === normalizeFieldKey(field)) continue;
    const prev = beforeByField.get(a.target_field);
    if (!prev) continue;
    if (STATUS_SEVERITY[a.status] > STATUS_SEVERITY[prev.status]) {
      regressions.push({
        field: a.target_field,
        before_status: prev.status,
        after_status: a.status,
        reason: a.notes || `Regressed from ${prev.status} to ${a.status}`,
      });
    }
  }

  const hasValue = Array.isArray(afterSummary.sample_value)
    ? afterSummary.sample_value.length > 0
    : afterSummary.sample_value !== null && String(afterSummary.sample_value).trim() !== '';

  return {
    ok:
      afterSummary.matched_count > 0 &&
      hasValue &&
      afterSummary.status !== 'BROKEN' &&
      regressions.length === 0,
    view: targetView,
    field,
    matched_count: afterSummary.matched_count,
    sample_value: afterSummary.sample_value,
    status: afterSummary.status,
    regressions,
    before_summary: beforeSummary,
    after_summary: afterSummary,
  };
}

export function extractFullAnchorTextPreview(el: Element): string {
  return extractFullText(el).slice(0, 200);
}
