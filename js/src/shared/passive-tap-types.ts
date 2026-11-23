export const PASSIVE_TAP_EVENT = 'upwork-buddy:passive-tap';
export const PASSIVE_TAP_READY_EVENT = 'upwork-buddy:passive-tap-ready';
export const PASSIVE_SEARCH_BATCH_EVENT = 'upwork-buddy:passive-search-batch';
export const PASSIVE_SPA_NAV_EVENT = 'upwork-buddy:passive-spa-nav';
export const PASSIVE_SEARCH_STATUS_EVENT = 'upwork-buddy:passive-search-status';

export type SearchFeedKind = 'search' | 'best_matches' | 'most_recent' | 'saved_jobs';

export interface PassiveTapPayload {
  kind: 'graphql' | 'xhr';
  url: string;
  operationName?: string;
  data: unknown;
  capturedAt: string;
  /** True when raw payload exceeded MAX_PAYLOAD_BYTES and data was summarized/projected. */
  truncated?: boolean;
  /** Original JSON byte size before projection/truncation. */
  originalBytes?: number;
}

export interface ProjectedGraphQLJob {
  upwork_job_id: string;
  job_title?: string;
  job_description?: string;
  canonical_url?: string;
  url?: string;
  contract_type?: 'hourly' | 'fixed' | '';
  budget?: string;
  budget_amount?: string;
  rate_range?: string;
  rate_min?: string;
  rate_max?: string;
  experience_level?: string;
  duration?: string;
  hours_per_week?: string;
  skills?: string;
  posted_text?: string;
  posted_at_est?: string;
  proposals_tier?: string;
  proposals_count?: number;
  connects_required?: number;
  client_country?: string;
  client_rating?: number;
  client_reviews?: number;
  client_spent?: string;
  client_spent_usd?: number;
  client_hires?: number;
  client_hire_rate?: number;
  payment_verified?: boolean;
}

export interface SearchPaginationMeta {
  totalCount?: number;
  offset?: number;
  count?: number;
  page?: number;
  perPage?: number;
  hasNextPage?: boolean;
  nextCursor?: string;
}

export interface PassiveSearchBatch {
  captureSeq: number;
  navigationEpoch: number;
  captureKind: 'graphql' | 'xhr' | 'spa_dom';
  requestUrl: string;
  pageUrl: string;
  operationName?: string;
  sourceFeed: SearchFeedKind;
  query?: string;
  jobs: ProjectedGraphQLJob[];
  paging?: SearchPaginationMeta;
  /** Explicit true when a recognized search operation returned an empty results list. */
  isExplicitEmpty?: boolean;
  /** Auth/challenge GraphQL error codes if returned inside HTTP 200 payload. */
  graphqlErrorCodes?: string[];
  rawBytes?: number;
  chunkIndex?: number;
  chunkCount?: number;
  capturedAt: string;
}

export interface PassiveSpaNavDetail {
  url: string;
  pathname: string;
  search: string;
  navigationEpoch: number;
  ts: string;
}

export interface PassiveSearchStatusDetail {
  inFlightCount: number;
  navigationEpoch: number;
}
