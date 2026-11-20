import type { DriftMode, MockServerConfig } from '../server/mock-types.ts';

const VALID_DRIFT_MODES: ReadonlySet<string> = new Set<DriftMode>([
  'healthy',
  'clean_no_fragile',
  'fragile',
  'degraded_fallback',
  'degraded_low_cards',
  'degraded_empty_text',
  'broken_typo_fixed',
  'broken_vue_hash',
  'broken_missing',
  'broken_search',
  'broken_v2_card',
  'broken_detail',
  'mutated_drift',
  'unmapped_auth',
]);

export function resolveEffectiveDriftMode(url: URL, config: MockServerConfig): DriftMode {
  const driftParam = url.searchParams.get('drift');
  if (driftParam && VALID_DRIFT_MODES.has(driftParam)) {
    return driftParam as DriftMode;
  }
  const q = url.searchParams.get('q') ?? '';
  if (q === 'mutated_drift' && config.driftMode === 'healthy') {
    return 'mutated_drift';
  }
  return config.driftMode;
}

export function renderUnmappedAuthHooks(): string {
  return `<div data-test="unmapped-auth-hooks" hidden>
  <span data-test="payment-verified">Payment Verified</span>
  <span data-qa="client-hire-rate">85% hire rate</span>
  <span data-test="connects-required">12 Connects</span>
  <span data-test="client-reviews">48 reviews</span>
  <span data-test="top-rated-badge">Top Rated Plus</span>
  <span data-test="interviewing-count">2 interviewing</span>
  <span data-test="invites-sent">4 invites sent</span>
  <span data-test="shared-hook">Shared A</span>
  <span data-test="shared-hook">Shared B</span>
  <span data-test="brand-new-hook">New 1</span>
  <span data-test="brand-new-hook">New 2</span>
  <span data-test="brand-new-hook">New 3</span>
</div>`;
}
