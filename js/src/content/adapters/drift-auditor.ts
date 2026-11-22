import type {
  AttributeHook,
  BaselineHookDiff,
  BlueprintViewType,
  DiscoveredFieldCandidate,
  DriftAuditReport,
  HookType,
  JobCardUIBlueprint,
  SectionLandmark,
  SelectorAuditEntry,
  SelectorHealthStatus,
  UpWorkPageBlueprint,
} from '../../shared/protocol';
import { BUNDLED_SELECTORS, type ExtractMode, type SelectorConfig } from '../../shared/selectors';
import {
  extractCaItemValue,
  extractFullText,
  parseHtmlDocument,
  queryAllSafe,
} from '../selector-engine';

export interface RegisteredSelector {
  view: string;
  target_field: string;
  css_selector: string;
  fallback_selectors: string[];
  description: string;
  is_fragile: boolean;
  fragile_reason: string;
  auth_only: boolean;
  expected_type: 'text' | 'list' | 'number' | 'element';
  extract_mode: ExtractMode;
  attribute?: string;
  label_contains?: string;
  sibling_child_tag?: string;
  join_with?: string;
}

export const STRIP_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'iframe',
  'canvas',
  'embed',
  'object',
]);

const CARD_SEARCH_VIEWS = new Set(['search_listings', 'best_matches', 'most_recent', 'saved_jobs']);

const UNMAPPED_AUTH_KEYWORDS = [
  'verified',
  'payment',
  'rating',
  'review',
  'hire',
  'spent',
  'connect',
  'badge',
  'score',
  'tier',
  'proposals',
  'interview',
  'invites',
] as const;

export function querySelectorAllSafe(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function collapsedText(el: Element | null | undefined): string {
  if (!el) return '';
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function resolveConfigViewName(
  targetView: string | undefined,
  inferredViewType: BlueprintViewType,
  root?: Element,
  url = '',
): string {
  const candidate = (targetView || inferredViewType || '').trim();
  if (candidate === 'search_results' || candidate === 'unknown' || candidate === '') {
    if (inferredViewType === 'job_detail') return 'job_detail';
    if (inferredViewType === 'best_matches') return 'best_matches';
    if (inferredViewType === 'most_recent') return 'most_recent';
    if (inferredViewType === 'saved_jobs') return 'saved_jobs';
    if (inferredViewType === 'proposal_apply') return 'proposal_apply';
    if (inferredViewType === 'proposals_list') return 'proposals_list';
    if (inferredViewType === 'messages_thread') return 'messages_thread';
    if (inferredViewType === 'messages_rooms') return 'messages_rooms';
    return 'search_listings';
  }
  if (candidate === 'messages') {
    if (
      /\/ab\/messages\/rooms\/[^/?#]+/.test(url) ||
      (root &&
        querySelectorAllSafe(
          root,
          "[data-test='message-item'], .story-item, [data-test='chat-story']",
        ).length > 0)
    ) {
      return 'messages_thread';
    }
    return 'messages_rooms';
  }
  return candidate;
}

export function buildRegisteredSelectors(
  config: SelectorConfig = BUNDLED_SELECTORS,
  targetView?: string,
  root?: Element,
  url = '',
): RegisteredSelector[] {
  const viewNames = targetView
    ? [resolveConfigViewName(targetView, 'unknown', root, url)]
    : Object.keys(config.views);

  const registry: RegisteredSelector[] = [];

  for (const viewName of viewNames) {
    const viewCfg = config.views[viewName];
    if (!viewCfg) continue;

    if (viewCfg.container_selectors && viewCfg.container_selectors.length > 0) {
      const isCardView = CARD_SEARCH_VIEWS.has(viewName);
      registry.push({
        view: viewName,
        target_field: isCardView ? 'job_cards_container' : 'items_container',
        css_selector: viewCfg.container_selectors[0],
        fallback_selectors: viewCfg.container_selectors.slice(1),
        description: `Container element for ${viewName}`,
        is_fragile: false,
        fragile_reason: '',
        auth_only: false,
        expected_type: 'element',
        extract_mode: 'text',
      });
    }

    const isCardSearchView = CARD_SEARCH_VIEWS.has(viewName);
    let emittedTitleAndUrl = false;

    for (const [fieldName, rule] of Object.entries(viewCfg.fields)) {
      let targetField = fieldName;
      if (isCardSearchView && (fieldName === 'title' || fieldName === 'url')) {
        if (emittedTitleAndUrl) {
          continue;
        }
        targetField = 'title_and_url';
        emittedTitleAndUrl = true;
      }

      registry.push({
        view: viewName,
        target_field: targetField,
        css_selector: rule.selectors[0],
        fallback_selectors: rule.selectors.slice(1),
        description: rule.description ?? '',
        is_fragile: Boolean(rule.is_fragile),
        fragile_reason: rule.fragile_reason ?? '',
        auth_only: Boolean(rule.auth_only),
        expected_type: rule.extract === 'list' ? 'list' : 'text',
        extract_mode: rule.extract,
        attribute: rule.attribute,
        label_contains: rule.label_contains,
        sibling_child_tag: rule.sibling_child_tag,
        join_with: rule.join_with,
      });
    }
  }

  return registry;
}

export function cloneAndCleanRoot(docOrRoot: Document | Element): Element {
  const sourceRoot =
    'documentElement' in docOrRoot ? (docOrRoot.documentElement ?? docOrRoot.body) : docOrRoot;

  const clone = sourceRoot.cloneNode(true) as Element;
  const stripSelector = Array.from(STRIP_TAGS).join(', ');
  for (const el of querySelectorAllSafe(clone, stripSelector)) {
    el.remove();
  }
  return clone;
}

export function harvestAttributeHooks(root: Element): AttributeHook[] {
  const hookMap = new Map<string, AttributeHook>();

  const recordHook = (
    hookType: HookType,
    name: string,
    tag: string,
    sampleText: string,
    addSampleValue = false,
  ): void => {
    if (!name) return;
    const key = `${hookType}:${name}`;
    const existing = hookMap.get(key);
    if (existing) {
      existing.frequency += 1;
      if (
        addSampleValue &&
        sampleText &&
        !existing.sample_values.includes(sampleText) &&
        existing.sample_values.length < 5
      ) {
        existing.sample_values.push(sampleText);
      }
      if (!existing.sample_text && sampleText) {
        existing.sample_text = sampleText;
      }
      return;
    }

    hookMap.set(key, {
      hook_type: hookType,
      name,
      tag,
      sample_text: sampleText || null,
      frequency: 1,
      sample_values: addSampleValue && sampleText ? [sampleText] : [],
    });
  };

  const elements = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    const sampleText = collapsedText(el).slice(0, 100);

    for (const attr of Array.from(el.attributes)) {
      const attrName = attr.name;
      const attrVal = attr.value.trim();

      if (attrName === 'data-test' || attrName === 'data-qa' || attrName === 'data-cy') {
        if (attrVal) {
          recordHook(attrName, attrVal, tag, sampleText, true);
        }
      } else if (attrName.startsWith('data-v-')) {
        recordHook('data-v', attrName, tag, sampleText, false);
      }
    }

    const classAttr = el.getAttribute('class') ?? '';
    if (classAttr) {
      for (const token of classAttr.trim().split(/\s+/)) {
        if (token.startsWith('air3-')) {
          recordHook('air3-class', token, tag, sampleText, false);
        }
      }
    }
  }

  return Array.from(hookMap.values()).sort((a, b) => b.frequency - a.frequency);
}

export function extractJobCardBlueprint(root: Element): JobCardUIBlueprint | null {
  let containerSelector = 'article.job-tile';
  let candidates = querySelectorAllSafe(root, 'article.job-tile');

  if (candidates.length === 0) {
    candidates = Array.from(root.querySelectorAll('[data-test]')).filter((el) => {
      const dt = el.getAttribute('data-test') ?? '';
      return /job[-_]?tile/i.test(dt) && el.tagName.toLowerCase() !== 'a';
    });
  }

  if (candidates.length === 0) {
    const feedCards = querySelectorAllSafe(
      root,
      "div[data-test='job-tile-list'] > section.air3-card-section, section[data-ev-sublocation='job_feed_tile']",
    );
    if (feedCards.length > 0) {
      candidates = feedCards;
      containerSelector = "div[data-test='job-tile-list'] > section.air3-card-section";
    }
  }

  if (candidates.length === 0) {
    const mainArticles = querySelectorAllSafe(root, 'main article');
    if (mainArticles.length > 0) {
      candidates = mainArticles;
      containerSelector = 'main article';
    }
  }

  // Deduplicate nested ancestors (keep outermost)
  const cards: Element[] = [];
  for (const cand of candidates) {
    const isNested = candidates.some((other) => other !== cand && other.contains(cand));
    if (!isNested) {
      cards.push(cand);
    }
  }

  if (cards.length === 0) {
    return null;
  }

  const card0Hooks = harvestAttributeHooks(cards[0]);
  const discoveredHooks: Record<string, AttributeHook> = {};
  for (const h of card0Hooks) {
    discoveredHooks[`${h.hook_type}:${h.name}`] = {
      ...h,
      sample_values: [...h.sample_values],
    };
  }

  for (let i = 1; i < cards.length; i++) {
    const cardHooks = harvestAttributeHooks(cards[i]);
    const seenInCard = new Set<string>();
    for (const h of cardHooks) {
      const key = `${h.hook_type}:${h.name}`;
      if (seenInCard.has(key)) continue;
      seenInCard.add(key);

      const existing = discoveredHooks[key];
      if (existing) {
        existing.frequency += 1;
        for (const sv of h.sample_values) {
          if (!existing.sample_values.includes(sv) && existing.sample_values.length < 5) {
            existing.sample_values.push(sv);
          }
        }
      } else {
        discoveredHooks[key] = {
          ...h,
          frequency: 1,
          sample_values: [...h.sample_values],
        };
      }
    }
  }

  const card0 = cards[0];
  const titleEl =
    card0.querySelector("a[data-test*='job-tile-title-link']") ??
    card0.querySelector('h3.job-tile-title a') ??
    card0.querySelector("a[href*='/jobs/']");
  const descEl =
    card0.querySelector("[data-test*='JobDescription'] p") ??
    card0.querySelector("[data-test*='JobDescription']") ??
    card0.querySelector("span[data-test='job-description-text']");
  const rateEl =
    card0.querySelector("[data-test='job-type-label']") ??
    card0.querySelector("[data-test='is-fixed-price']") ??
    card0.querySelector("strong[data-test='job-type']");
  const skillEls = querySelectorAllSafe(
    card0,
    "[data-test='token'] span, .air3-token span, [data-test='token-container'] [data-test='attr-item']",
  );
  const proposalsEl =
    card0.querySelector("[data-test='proposals-tier']") ??
    card0.querySelector("[data-test='proposals']") ??
    card0.querySelector("strong[data-test='proposals']");

  const sampleCardData: Record<string, unknown> = {
    title: collapsedText(titleEl),
    href: titleEl?.getAttribute('href') ?? '',
    description: collapsedText(descEl).slice(0, 140),
    rate: collapsedText(rateEl),
    skills: skillEls.map((el) => collapsedText(el)).filter(Boolean),
    proposals: collapsedText(proposalsEl),
  };

  return {
    container_selector: containerSelector,
    total_cards_detected: cards.length,
    discovered_hooks: discoveredHooks,
    sample_card_data: sampleCardData,
  };
}

export function extractLandmarks(root: Element): SectionLandmark[] {
  const landmarks: SectionLandmark[] = [];
  for (const tagName of ['header', 'nav', 'main', 'aside', 'footer']) {
    for (const el of querySelectorAllSafe(root, tagName)) {
      landmarks.push({
        tag: tagName,
        id: el.getAttribute('id'),
        class: el.getAttribute('class') ?? '',
        data_test: el.getAttribute('data-test'),
      });
    }
  }
  return landmarks;
}

function extractLowerPathname(rawUrl: string): string {
  try {
    return new URL(rawUrl, 'https://www.upwork.com').pathname.toLowerCase();
  } catch {
    return (rawUrl.split(/[?#]/)[0] ?? '').toLowerCase();
  }
}

export function inferViewType(url: string, root: Element): BlueprintViewType {
  const lowerUrl = url.toLowerCase();
  const pathname = extractLowerPathname(url);
  if (
    /\/ab\/messages\/rooms\/[^/]+/.test(pathname) ||
    querySelectorAllSafe(root, "[data-test='message-item'], .story-item, [data-test='chat-story']")
      .length > 0
  ) {
    return 'messages_thread';
  }
  if (pathname.includes('/ab/messages')) {
    return 'messages_rooms';
  }
  if (pathname.includes('/nx/proposals/job/') || /\/proposals\/.*\/apply/.test(pathname)) {
    return 'proposal_apply';
  }
  if (pathname.includes('/nx/proposals')) {
    return 'proposals_list';
  }
  if (
    pathname.includes('/search/jobs') ||
    (pathname.startsWith('/nx/search') && /[?&]q=/.test(lowerUrl))
  ) {
    return 'search_results';
  }
  if (pathname.includes('best-matches')) {
    return 'best_matches';
  }
  if (pathname.includes('most-recent')) {
    return 'most_recent';
  }
  if (pathname.includes('saved-jobs')) {
    return 'saved_jobs';
  }
  if (pathname.includes('/nx/find-work')) {
    return 'best_matches';
  }
  if (
    pathname.includes('/jobs/') ||
    pathname.includes('/freelance-jobs/apply/') ||
    pathname.includes('nx/job-details') ||
    pathname.includes('_~') ||
    root.querySelector('.job-details-content')
  ) {
    return 'job_detail';
  }
  return 'unknown';
}

export function buildPageBlueprint(
  docOrHtml: Document | string,
  opts: {
    url: string;
    title?: string;
    isAuthenticated?: boolean;
    statusCode?: number;
    proxyUsed?: string;
    capturedXhrEndpoints?: string[];
  },
): UpWorkPageBlueprint {
  const timestamp = new Date().toISOString();
  if (typeof docOrHtml === 'string' && !docOrHtml.trim()) {
    return {
      view_type: 'unknown',
      url: opts.url,
      title: opts.title ?? '',
      timestamp,
      is_authenticated: opts.isAuthenticated ?? false,
      status_code: opts.statusCode ?? 200,
      proxy_used: opts.proxyUsed ?? 'Direct',
      screenshot_path: null,
      job_card_blueprint: null,
      all_hooks: [],
      section_landmarks: [],
      captured_xhr_endpoints: opts.capturedXhrEndpoints ?? [],
    };
  }

  const doc = typeof docOrHtml === 'string' ? parseHtmlDocument(docOrHtml) : docOrHtml;
  const cleanedRoot = cloneAndCleanRoot(doc);
  const title = opts.title ?? doc.title ?? '';
  const viewType = inferViewType(opts.url, cleanedRoot);
  const allHooks = harvestAttributeHooks(cleanedRoot);
  const jobCardBlueprint = extractJobCardBlueprint(cleanedRoot);
  const sectionLandmarks = extractLandmarks(cleanedRoot);

  return {
    view_type: viewType,
    url: opts.url,
    title,
    timestamp,
    is_authenticated: opts.isAuthenticated ?? false,
    status_code: opts.statusCode ?? 200,
    proxy_used: opts.proxyUsed ?? 'Direct',
    screenshot_path: null,
    job_card_blueprint: jobCardBlueprint,
    all_hooks: allHooks,
    section_landmarks: sectionLandmarks,
    captured_xhr_endpoints: opts.capturedXhrEndpoints ?? [],
  };
}

export function computeOverallAuditStatus(report: DriftAuditReport): SelectorHealthStatus {
  if (report.broken_selectors_count > 0) return 'BROKEN';
  if (report.degraded_selectors_count > 0) return 'DEGRADED';
  if (report.fragile_selectors_count > 0) return 'FRAGILE';
  return 'HEALTHY';
}

export class DriftAuditor {
  private readonly blueprint: UpWorkPageBlueprint;
  private readonly root: ParentNode;
  private readonly config: SelectorConfig;
  private readonly baseline: UpWorkPageBlueprint | null;

  constructor(
    blueprint: UpWorkPageBlueprint,
    docOrRoot: Document | Element | string,
    config: SelectorConfig = BUNDLED_SELECTORS,
    baseline: UpWorkPageBlueprint | null = null,
  ) {
    this.blueprint = blueprint;
    if (typeof docOrRoot === 'string') {
      this.root = parseHtmlDocument(docOrRoot);
    } else {
      this.root = docOrRoot;
    }
    this.config = config;
    this.baseline = baseline;
  }

  audit(targetView?: string): DriftAuditReport {
    const rootEl: Element | undefined =
      'documentElement' in this.root
        ? ((this.root as Document).documentElement ?? (this.root as Document).body ?? undefined)
        : (this.root as Element);

    const relevantView = resolveConfigViewName(
      targetView,
      this.blueprint.view_type,
      rootEl,
      this.blueprint.url,
    );

    const registry = buildRegisteredSelectors(
      this.config,
      relevantView,
      rootEl,
      this.blueprint.url,
    );

    const audits: SelectorAuditEntry[] = [];
    const breakingChanges: string[] = [];

    let healthyCount = 0;
    let degradedCount = 0;
    let brokenCount = 0;
    let fragileCount = 0;

    for (const reg of registry) {
      const entry = this.auditSingleSelector(reg);
      audits.push(entry);

      switch (entry.status) {
        case 'HEALTHY':
          healthyCount += 1;
          break;
        case 'DEGRADED':
          degradedCount += 1;
          break;
        case 'BROKEN':
          brokenCount += 1;
          breakingChanges.push(
            `BROKEN: ${entry.view}.${entry.target_field} (${entry.registered_selector})`,
          );
          break;
        case 'FRAGILE':
          fragileCount += 1;
          breakingChanges.push(
            `FRAGILE: ${entry.view}.${entry.target_field} (${entry.notes || entry.registered_selector})`,
          );
          break;
      }
    }

    const discoveredCandidates = this.discoverUnmappedFields(relevantView, registry);
    const baselineDiffs = this.diffAgainstBaseline();
    for (const d of baselineDiffs) {
      if (d.change_type === 'REMOVED' || d.change_type === 'FREQUENCY_DROPPED') {
        breakingChanges.push(`BASELINE DRIFT: Hook '${d.hook_name}' ${d.notes}`);
      }
    }

    return {
      timestamp: new Date().toISOString(),
      url: this.blueprint.url,
      view_type: relevantView,
      is_authenticated: this.blueprint.is_authenticated,
      healthy_selectors_count: healthyCount,
      degraded_selectors_count: degradedCount,
      broken_selectors_count: brokenCount,
      fragile_selectors_count: fragileCount,
      audits,
      discovered_candidates: discoveredCandidates,
      breaking_changes_detected: breakingChanges,
      baseline_diffs: baselineDiffs,
    };
  }

  private auditSingleSelector(reg: RegisteredSelector): SelectorAuditEntry {
    const matches = queryAllSafe(this.root, reg.css_selector);
    const count = matches.length;

    if (count === 0) {
      if (reg.is_fragile) {
        return {
          target_field: reg.target_field,
          view: reg.view,
          registered_selector: reg.css_selector,
          status: 'BROKEN',
          matched_count: 0,
          sample_extracted_value: null,
          notes: reg.fragile_reason || 'Fragile primary selector matched 0 elements',
          suggested_replacement: this.findReplacementForBroken(reg),
        };
      }

      for (const fb of reg.fallback_selectors) {
        const fbMatches = queryAllSafe(this.root, fb);
        if (fbMatches.length > 0) {
          const sampleVal = this.extractSampleValue(fbMatches, reg);
          if (fb.includes('data-v-')) {
            const stableFallback = reg.fallback_selectors.find(
              (alt) => !alt.includes('data-v-') && queryAllSafe(this.root, alt).length > 0,
            );
            const replacement =
              stableFallback ?? this.findReplacementForBroken({ ...reg, css_selector: fb }) ?? fb;
            return {
              target_field: reg.target_field,
              view: reg.view,
              registered_selector: reg.css_selector,
              status: 'FRAGILE',
              matched_count: fbMatches.length,
              sample_extracted_value: sampleVal,
              notes: `Primary selector failed; matched via fragile Vue hash fallback '${fb}'`,
              suggested_replacement: replacement,
            };
          }
          return {
            target_field: reg.target_field,
            view: reg.view,
            registered_selector: reg.css_selector,
            status: 'DEGRADED',
            matched_count: fbMatches.length,
            sample_extracted_value: sampleVal,
            notes: `Primary selector failed; matched via fallback '${fb}'`,
            suggested_replacement: fb,
          };
        }
      }

      return {
        target_field: reg.target_field,
        view: reg.view,
        registered_selector: reg.css_selector,
        status: 'BROKEN',
        matched_count: 0,
        sample_extracted_value: null,
        notes: 'Primary and all fallback selectors matched 0 elements',
        suggested_replacement: this.findReplacementForBroken(reg),
      };
    }

    const sampleVal = this.extractSampleValue(matches, reg);

    if (reg.is_fragile) {
      return {
        target_field: reg.target_field,
        view: reg.view,
        registered_selector: reg.css_selector,
        status: 'FRAGILE',
        matched_count: count,
        sample_extracted_value: sampleVal,
        notes: reg.fragile_reason || 'Selector marked fragile',
        suggested_replacement: this.findReplacementForBroken(reg),
      };
    }

    const isEmptySample = Array.isArray(sampleVal)
      ? sampleVal.length === 0
      : sampleVal === null || sampleVal === '';

    if ((reg.expected_type === 'text' || reg.expected_type === 'list') && isEmptySample) {
      return {
        target_field: reg.target_field,
        view: reg.view,
        registered_selector: reg.css_selector,
        status: 'DEGRADED',
        matched_count: count,
        sample_extracted_value: sampleVal,
        notes: 'Matched elements produced empty text',
        suggested_replacement: this.findReplacementForBroken(reg),
      };
    }

    const totalCards = this.blueprint.job_card_blueprint?.total_cards_detected ?? 0;
    if (
      totalCards > 0 &&
      (reg.target_field === 'title_and_url' ||
        reg.target_field === 'description' ||
        reg.target_field === 'hourly_rate') &&
      count < Math.floor(totalCards / 2)
    ) {
      return {
        target_field: reg.target_field,
        view: reg.view,
        registered_selector: reg.css_selector,
        status: 'DEGRADED',
        matched_count: count,
        sample_extracted_value: sampleVal,
        notes: `Low match rate (${count}/${totalCards} cards)`,
        suggested_replacement: this.findReplacementForBroken(reg),
      };
    }

    return {
      target_field: reg.target_field,
      view: reg.view,
      registered_selector: reg.css_selector,
      status: 'HEALTHY',
      matched_count: count,
      sample_extracted_value: sampleVal,
      notes: '',
      suggested_replacement: null,
    };
  }

  private extractSampleValue(
    matches: Element[],
    reg: RegisteredSelector,
  ): string | string[] | null {
    if (matches.length === 0) return null;

    if (reg.extract_mode === 'ca_item_value') {
      const val = extractCaItemValue(matches, reg.label_contains);
      return val !== null ? val.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
    }

    if (reg.sibling_child_tag) {
      const parent = matches[0].parentElement;
      if (!parent) return '';
      const sibs = querySelectorAllSafe(parent, reg.sibling_child_tag);
      const texts = sibs.map((s) => collapsedText(s)).filter(Boolean);
      return texts.join(reg.join_with || ' ').slice(0, 100);
    }

    if (reg.expected_type === 'list') {
      return matches
        .slice(0, 5)
        .map((m) => collapsedText(m))
        .filter(Boolean);
    }

    if (reg.expected_type === 'element') {
      const cls = matches[0].getAttribute('class') ?? 'element';
      return `<${cls}>`;
    }

    if (reg.extract_mode === 'attribute' && reg.attribute) {
      return (matches[0].getAttribute(reg.attribute) ?? '').slice(0, 100);
    }

    return extractFullText(matches[0]).slice(0, 100);
  }

  private findReplacementForBroken(reg: RegisteredSelector): string | null {
    if (reg.css_selector.includes('pubilshed')) {
      const match = this.blueprint.all_hooks.find(
        (h) => h.hook_type === 'data-test' && h.name.includes('publish'),
      );
      if (match) {
        return `[data-test='${match.name}'] span`;
      }
    }

    if (reg.css_selector.includes('data-v-')) {
      const stable = querySelectorAllSafe(
        this.root,
        ".skills-list .air3-line-clamp, [data-test='Skill'] span",
      );
      if (stable.length > 0) {
        return '.skills-list .air3-line-clamp';
      }
    }

    const fieldSlug = reg.target_field.replace(/_/g, '-');
    const hookMatch = this.blueprint.all_hooks.find((h) =>
      h.name.toLowerCase().includes(fieldSlug),
    );
    if (hookMatch) {
      if (hookMatch.hook_type === 'air3-class') {
        return `.${hookMatch.name}`;
      }
      if (hookMatch.hook_type === 'id') {
        return `#${hookMatch.name}`;
      }
      return `[${hookMatch.hook_type}='${hookMatch.name}']`;
    }

    return null;
  }

  private discoverUnmappedFields(
    view: string,
    registry: RegisteredSelector[],
  ): DiscoveredFieldCandidate[] {
    const registeredHookNames = new Set<string>();
    const attrPattern = /\[(data-[a-zA-Z0-9_-]+)[*^$]?=['"]([^'"]+)['"]\]/g;
    const classPattern = /\.(air3-[a-zA-Z0-9_-]+)/g;
    const idPattern = /#([a-zA-Z0-9_-]+)/g;
    for (const r of registry) {
      for (const sel of [r.css_selector, ...r.fallback_selectors]) {
        for (const pat of [attrPattern, classPattern, idPattern]) {
          pat.lastIndex = 0;
          let match = pat.exec(sel);
          while (match !== null) {
            registeredHookNames.add(pat === attrPattern ? match[2] : match[1]);
            match = pat.exec(sel);
          }
        }
      }
    }

    const hooksToScan =
      CARD_SEARCH_VIEWS.has(view) && this.blueprint.job_card_blueprint
        ? Object.values(this.blueprint.job_card_blueprint.discovered_hooks)
        : this.blueprint.all_hooks;

    const candidates: DiscoveredFieldCandidate[] = [];
    for (const hook of hooksToScan) {
      if (registeredHookNames.has(hook.name)) {
        continue;
      }
      const lowerName = hook.name.toLowerCase();
      if (!UNMAPPED_AUTH_KEYWORDS.some((kw) => lowerName.includes(kw))) {
        continue;
      }
      const suggestedSelector =
        hook.hook_type === 'air3-class'
          ? `.${hook.name}`
          : hook.hook_type === 'id'
            ? `#${hook.name}`
            : `[${hook.hook_type}='${hook.name}']`;

      candidates.push({
        hook_name: hook.name,
        suggested_selector: suggestedSelector,
        sample_text: hook.sample_text ?? '',
        element_tag: hook.tag,
        confidence: hook.sample_text ? 'HIGH' : 'MEDIUM',
        notes: `Unmapped ${hook.hook_type} hook (frequency=${hook.frequency})`,
      });

      if (candidates.length >= 15) {
        break;
      }
    }

    return candidates;
  }

  private diffAgainstBaseline(): BaselineHookDiff[] {
    if (!this.baseline) {
      return [];
    }

    const baseMap = new Map<string, AttributeHook>();
    for (const h of this.baseline.all_hooks ?? []) {
      baseMap.set(`${h.hook_type}:${h.name}`, h);
    }

    const currMap = new Map<string, AttributeHook>();
    for (const h of this.blueprint.all_hooks ?? []) {
      currMap.set(`${h.hook_type}:${h.name}`, h);
    }

    const hookTypePriority = (hookType: string): number => {
      switch (hookType) {
        case 'data-test':
          return 0;
        case 'data-qa':
          return 1;
        case 'data-cy':
          return 2;
        case 'id':
          return 3;
        case 'air3-class':
          return 4;
        case 'data-v':
          return 5;
        default:
          return 6;
      }
    };

    const removed: BaselineHookDiff[] = [];
    const dropped: BaselineHookDiff[] = [];
    const added: BaselineHookDiff[] = [];

    for (const [key, baseH] of baseMap.entries()) {
      const currH = currMap.get(key);
      if (!currH) {
        removed.push({
          hook_name: baseH.name,
          hook_type: baseH.hook_type,
          change_type: 'REMOVED',
          baseline_frequency: baseH.frequency,
          current_frequency: 0,
          notes: `removed from DOM (was frequency ${baseH.frequency})`,
        });
      } else if (baseH.frequency >= 4 && currH.frequency < Math.floor(baseH.frequency / 2)) {
        dropped.push({
          hook_name: baseH.name,
          hook_type: baseH.hook_type,
          change_type: 'FREQUENCY_DROPPED',
          baseline_frequency: baseH.frequency,
          current_frequency: currH.frequency,
          notes: `frequency dropped from ${baseH.frequency} to ${currH.frequency}`,
        });
      }
    }

    for (const [key, currH] of currMap.entries()) {
      if (!baseMap.has(key) && currH.frequency >= 2) {
        added.push({
          hook_name: currH.name,
          hook_type: currH.hook_type,
          change_type: 'ADDED',
          baseline_frequency: 0,
          current_frequency: currH.frequency,
          notes: `new hook appeared (frequency ${currH.frequency})`,
        });
      }
    }

    const byPriority = (a: BaselineHookDiff, b: BaselineHookDiff): number =>
      hookTypePriority(a.hook_type) - hookTypePriority(b.hook_type);

    removed.sort(byPriority);
    dropped.sort(byPriority);
    added.sort(byPriority);

    const balanced: BaselineHookDiff[] = [];
    const buckets = [added, removed, dropped];
    let idx = 0;
    while (balanced.length < 10) {
      let pushedInRound = false;
      for (const bucket of buckets) {
        if (idx < bucket.length && balanced.length < 10) {
          balanced.push(bucket[idx]);
          pushedInRound = true;
        }
      }
      if (!pushedInRound) {
        break;
      }
      idx += 1;
    }

    return balanced;
  }
}
