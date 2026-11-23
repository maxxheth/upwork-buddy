import { z } from 'zod';

export const STORAGE_KEYS = {
  API_URL: 'local:upworkBuddyApiUrl',
  AUTH_TOKEN: 'local:upworkBuddyAuthToken',
  PACING_SECONDS: 'local:upworkBuddyPacingSeconds',
  JITTER_RATIO: 'local:upworkBuddyJitterRatio',
  SELECTORS_CACHE: 'local:upworkBuddySelectorsCache',
  SELECTORS_ETAG: 'local:upworkBuddySelectorsEtag',
  SELECTOR_BASELINES: 'local:upworkBuddySelectorBaselines',
  POLICY_CAPS: 'local:upworkBuddyPolicyCaps',
  UNREAD_POLL_ENABLED: 'local:upworkBuddyUnreadPollEnabled',
  UNREAD_POLL_MINUTES: 'local:upworkBuddyUnreadPollMinutes',
} as const;

export const DEFAULT_API_URL = 'http://127.0.0.1:9090';
export const DEFAULT_PACING_SECONDS = 4.5;
export const DEFAULT_JITTER_RATIO = 0.5;

export const ScreeningQuestionSchema = z.object({
  index: z.number().int().nonnegative(),
  prompt: z.string(),
  required: z.boolean().default(false),
});
export type ScreeningQuestion = z.infer<typeof ScreeningQuestionSchema>;

export const JobAttachmentSchema = z.object({
  filename: z.string(),
  url: z.string(),
});
export type JobAttachment = z.infer<typeof JobAttachmentSchema>;

export const JobQualificationSchema = z.object({
  name: z.string(),
  value: z.string(),
  met: z.boolean().nullable().optional(),
});
export type JobQualification = z.infer<typeof JobQualificationSchema>;

export const ClientActivitySchema = z.object({
  interviewing: z.number().int().nonnegative().optional(),
  invites_sent: z.number().int().nonnegative().optional(),
  unanswered_invites: z.number().int().nonnegative().optional(),
  last_viewed: z.string().optional(),
  avg_hourly_rate_paid: z.string().optional(),
});
export type ClientActivity = z.infer<typeof ClientActivitySchema>;

export const ScoreBreakdownSchema = z.record(z.string(), z.unknown());
export type ScoreBreakdown = z.infer<typeof ScoreBreakdownSchema>;

export const PortfolioReferenceSchema = z.object({
  source: z.string(),
  display_name: z.string(),
  visibility: z.string(),
  link: z.string().optional(),
  summary: z.string().optional(),
  activity_tier: z.string().optional(),
  tech_stack: z.array(z.string()).optional(),
});
export type PortfolioReference = z.infer<typeof PortfolioReferenceSchema>;

export const AIEnrichmentStatusSchema = z.enum([
  'none',
  'queued',
  'scraping_details',
  'analyzing',
  'completed',
  'failed',
]);

export const JobUpsertPayloadSchema = z.object({
  job_title: z.string().optional(),
  job_description: z.string().optional(),
  url: z.string().optional(),
  job_url: z.string().optional(),
  upwork_job_id: z.string().optional(),
  canonical_url: z.string().optional(),
  source: z.string().optional(),
  source_feed: z.string().optional(),
  source_query: z.string().optional(),
  status: z.string().optional(),
  contract_type: z.string().optional(),
  budget: z.string().optional(),
  rate_range: z.string().optional(),
  rate_min: z.string().optional(),
  rate_max: z.string().optional(),
  budget_amount: z.string().optional(),
  experience_level: z.string().optional(),
  skills: z.union([z.string(), z.array(z.string())]).optional(),
  proposal: z.string().optional(),
  proposal_subject: z.string().optional(),
  proposal_tone: z.string().optional(),
  proposal_json: z.unknown().optional(),
  time_estimate: z.unknown().optional(),
  workload_division: z.unknown().optional(),
  questions_for_client: z.unknown().optional(),
  tips_and_advice: z.unknown().optional(),
  execution_prompt: z.string().optional(),
  tone_analysis: z.string().optional(),
  posted_text: z.string().optional(),
  posted_at_est: z.string().optional(),
  duration: z.string().optional(),
  hours_per_week: z.string().optional(),
  proposals_tier: z.string().optional(),
  proposals_count: z.number().int().nonnegative().nullable().optional(),
  connects_required: z.number().int().nonnegative().nullable().optional(),
  screening_questions: z.array(ScreeningQuestionSchema).optional(),
  attachments: z.array(JobAttachmentSchema).optional(),
  qualifications: z.array(JobQualificationSchema).optional(),
  client_country: z.string().optional(),
  client_rating: z.number().nullable().optional(),
  client_reviews: z.number().int().nonnegative().nullable().optional(),
  client_spent: z.string().optional(),
  client_spent_usd: z.number().nonnegative().nullable().optional(),
  client_hires: z.number().int().nonnegative().nullable().optional(),
  client_hire_rate: z.number().nonnegative().nullable().optional(),
  payment_verified: z.boolean().nullable().optional(),
  client_avg_hourly: z.string().optional(),
  client_activity: ClientActivitySchema.optional(),
  score: z.number().nullable().optional(),
  score_breakdown: ScoreBreakdownSchema.optional(),
  score_reasoning: z.string().optional(),
  fit_label: z.string().optional(),
  fit_assessment: z.string().optional(),
  portfolio_references: z.array(PortfolioReferenceSchema).optional(),
  last_enriched_at: z.string().nullable().optional(),
  ai_enrichment_status: z.string().optional(),
  ai_enriched_at: z.string().nullable().optional(),
  ai_enrichment_error: z.string().optional(),
  ai_model: z.string().optional(),
  ai_effort: z.string().optional(),
  ai_tokens_used: z.number().int().nullable().optional(),
  last_search_run_id: z.number().int().nullable().optional(),
});
export type JobUpsertPayload = z.infer<typeof JobUpsertPayloadSchema>;

export const SavedJobSchema = JobUpsertPayloadSchema.extend({
  id: z.number().int(),
  created_at: z.string().optional(),
});
export type SavedJobV2 = z.infer<typeof SavedJobSchema>;

export const ProposalMilestoneSchema = z.object({
  description: z.string(),
  due_date: z.string().optional(),
  amount: z.number().nonnegative(),
});
export type ProposalMilestone = z.infer<typeof ProposalMilestoneSchema>;

export const ProposalDraftSchema = z.object({
  id: z.number().int().optional(),
  job_id: z.number().int().nullable().optional(),
  upwork_job_id: z.string(),
  job_title: z.string().optional(),
  cover_letter: z.string(),
  bid_type: z.enum(['hourly', 'fixed', '']),
  bid_amount: z.number().nonnegative().nullable().optional(),
  milestones: z.array(ProposalMilestoneSchema).optional(),
  screening_answers: z
    .array(
      z.object({
        index: z.number().int(),
        prompt: z.string(),
        answer: z.string(),
        required: z.boolean().optional(),
      }),
    )
    .optional(),
  connects_required: z.number().int().nonnegative().nullable().optional(),
  boost_connects: z.number().int().nonnegative().nullable().optional(),
  status: z.enum([
    'draft',
    'pending_approval',
    'approved',
    'submitted',
    'viewed',
    'interviewing',
    'offer',
    'archived',
    'rejected',
  ]),
  approval_token: z.string().optional(),
  upwork_proposal_url: z.string().optional(),
});
export type ProposalDraft = z.infer<typeof ProposalDraftSchema>;

export const ProposalVerificationSnapshotSchema = z.object({
  ok: z.boolean().optional(),
  cover_letter_length: z.number().int(),
  bid_type: z.string(),
  bid_amount: z.number().nullable(),
  estimated_fee: z.number().nullable().optional(),
  estimated_net: z.number().nullable().optional(),
  connects_cost: z.number().int().nullable(),
  boost_connects: z.number().int().nullable().optional(),
  total_connects: z.number().int().nonnegative().optional(),
  available_connects: z.number().int().nonnegative().nullable().optional(),
  insufficient_connects: z.boolean().optional(),
  rate_increase: z.string().optional(),
  attachment_state: z
    .object({
      present: z.boolean(),
      files_count: z.number().int().nonnegative(),
      filenames: z.array(z.string()),
    })
    .optional(),
  unanswered_required_questions: z.number().int().nonnegative(),
  screening_answers: z.array(
    z.object({
      index: z.number().int().optional(),
      prompt: z.string(),
      answer: z.string(),
      required: z.boolean(),
    }),
  ),
});
export type ProposalVerificationSnapshot = z.infer<typeof ProposalVerificationSnapshotSchema>;

export const ScreeningAnswerInputSchema = z.union([
  z.string(),
  z.object({
    index: z.number().int().nonnegative().optional(),
    prompt: z.string().optional(),
    answer: z.string(),
    required: z.boolean().optional(),
  }),
]);
export type ScreeningAnswerInput = z.infer<typeof ScreeningAnswerInputSchema>;

export const ProposalFillParamsSchema = z.object({
  proposal_id: z.number().int().positive().optional(),
  upwork_job_id: z.string().min(1),
  apply_url: z.string().optional(),
  cover_letter: z.string().min(1),
  bid_type: z.enum(['hourly', 'fixed', '']).default(''),
  bid_amount: z.number().nonnegative().nullable().optional(),
  milestones: z.array(ProposalMilestoneSchema).optional(),
  rate_increase: z.string().optional(),
  duration: z.string().optional(),
  boost_connects: z.number().int().nonnegative().nullable().optional(),
  screening_answers: z.array(ScreeningAnswerInputSchema).optional(),
});
export type ProposalFillParams = z.infer<typeof ProposalFillParamsSchema>;

export const ProposalSubmitParamsSchema = z.object({
  proposal_id: z.number().int().positive().optional(),
  upwork_job_id: z.string().min(1),
  apply_url: z.string().optional(),
  cover_letter: z.string().optional(),
  bid_type: z.enum(['hourly', 'fixed', '']).optional(),
  bid_amount: z.number().nonnegative().nullable().optional(),
  milestones: z.array(ProposalMilestoneSchema).optional(),
  rate_increase: z.string().optional(),
  duration: z.string().optional(),
  boost_connects: z.number().int().nonnegative().nullable().optional(),
  screening_answers: z.array(ScreeningAnswerInputSchema).optional(),
});
export type ProposalSubmitParams = z.infer<typeof ProposalSubmitParamsSchema>;

export const MessagesListParamsSchema = z.object({
  persist: z.boolean().optional(),
});
export type MessagesListParams = z.infer<typeof MessagesListParamsSchema>;

export const MessagesGetParamsSchema = z.object({
  room_id: z.string().min(1),
});
export type MessagesGetParams = z.infer<typeof MessagesGetParamsSchema>;

export const MessagesDraftParamsSchema = z.object({
  room_id: z.string().min(1),
  body: z.string().min(1),
  prefill_composer: z.boolean().optional(),
});
export type MessagesDraftParams = z.infer<typeof MessagesDraftParamsSchema>;

export const MessagesSendParamsSchema = z.object({
  room_id: z.string().min(1),
  body: z.string().optional(),
});
export type MessagesSendParams = z.infer<typeof MessagesSendParamsSchema>;

export const MessageAttachmentSchema = z.object({
  filename: z.string(),
  url: z.string(),
});
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

export const MessageThreadSchema = z.object({
  id: z.number().int().optional(),
  upwork_room_id: z.string().min(1),
  client_name: z.string(),
  client_company: z.string().optional(),
  job_title: z.string().optional(),
  unread_count: z.number().int().nonnegative(),
  last_message_snippet: z.string(),
  last_message_at: z.string().nullable().optional(),
});
export type MessageThread = z.infer<typeof MessageThreadSchema>;

export const MessageItemSchema = z.object({
  id: z.number().int().optional(),
  upwork_message_id: z.string().optional(),
  sender: z.string(),
  sender_role: z.enum(['client', 'freelancer', 'system', '']),
  body: z.string(),
  sent_at: z.string().nullable().optional(),
  attachments: z.array(MessageAttachmentSchema).optional(),
  is_draft: z.boolean().default(false),
  status: z.enum(['received', 'draft', 'pending_approval', 'approved', 'sent', 'failed']),
  approval_token: z.string().optional(),
});
export type MessageItem = z.infer<typeof MessageItemSchema>;

export const ExtensionSettingsSchema = z.object({
  apiBaseUrl: z.url(),
  apiToken: z.string(),
  pacingSeconds: z.number().min(0).max(120),
  jitterRatio: z.number().min(0).max(0.9),
});
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;

export const SearchSourceSchema = z.enum(['search', 'best_matches', 'most_recent', 'saved_jobs']);
export type SearchSource = z.infer<typeof SearchSourceSchema>;

export const SearchRunFiltersSchema = z
  .object({
    required_keywords: z.array(z.string()).optional(),
    exclude_keywords: z.array(z.string()).optional(),
    min_score: z.number().int().min(0).max(100).optional(),
    max_posted_age_days: z.number().int().nonnegative().optional(),
    max_proposals: z.number().int().nonnegative().optional(),
    budget_min: z.number().nonnegative().optional(),
    budget_max: z.number().nonnegative().optional(),
    hourly_rate_min: z.number().nonnegative().optional(),
    hourly_rate_max: z.number().nonnegative().optional(),
    payment_verified_only: z.boolean().optional(),
    sort_by_score: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.hourly_rate_min === undefined ||
      data.hourly_rate_max === undefined ||
      data.hourly_rate_min <= data.hourly_rate_max,
    {
      message: 'hourly_rate_min cannot exceed hourly_rate_max',
      path: ['hourly_rate_max'],
    },
  );
export type SearchRunFilters = z.infer<typeof SearchRunFiltersSchema>;

export const SearchRunRequestSchema = z
  .object({
    source: SearchSourceSchema.default('search'),
    query: z.string().optional(),
    queries: z.array(z.string()).optional(),
    sort: z.enum(['recency', 'relevance']).optional(),
    per_page: z.union([z.literal(10), z.literal(20), z.literal(50)]).optional(),
    contractor_tier: z.array(z.number().int().min(1).max(3)).optional(),
    contract_type: z.enum(['hourly', 'fixed']).optional(),
    proposal_tiers: z.array(z.string()).optional(),
    budget_min: z.number().nonnegative().optional(),
    budget_max: z.number().nonnegative().optional(),
    hourly_rate_min: z.number().nonnegative().optional(),
    hourly_rate_max: z.number().nonnegative().optional(),
    payment_verified_only: z.boolean().optional(),
    category: z.string().optional(),
    search_url: z.string().optional(),
    start_page: z.number().int().min(1).default(1),
    max_pages: z.number().int().min(1).max(20).default(1),
    target_jobs: z.number().int().min(1).max(200).optional(),
    enrich_top_n: z.number().int().min(0).max(50).optional(),
    skip_auto_detail_enrich: z.boolean().optional(),
    skip_if_busy: z.boolean().optional(),
    auto_ingest: z.boolean().optional(),
    profile_id: z.number().int().positive().optional(),
    run_label: z.string().optional(),
    from_active_projects: z.boolean().optional(),
    active_project_keys: z.array(z.string()).optional(),
    active_project_tiers: z.array(z.string()).optional(),
    filters: SearchRunFiltersSchema.optional(),
  })
  .refine(
    (data) =>
      data.hourly_rate_min === undefined ||
      data.hourly_rate_max === undefined ||
      data.hourly_rate_min <= data.hourly_rate_max,
    {
      message: 'hourly_rate_min cannot exceed hourly_rate_max',
      path: ['hourly_rate_max'],
    },
  );
export type SearchRunRequest = z.infer<typeof SearchRunRequestSchema>;

export const DetailEnrichRequestSchema = z.object({
  url: z.string().optional(),
  upwork_job_id: z.string().optional(),
  urls: z.array(z.string()).optional(),
  max_jobs: z.number().int().min(1).max(50).optional(),
  persist: z.boolean().optional(),
  require_drawer: z.boolean().optional(),
});
export type DetailEnrichRequest = z.infer<typeof DetailEnrichRequestSchema>;

export const SearchProfileConfigSchema = z.object({
  name: z.string(),
  description: z.string().default(''),
  selectors_file: z.string().optional(),
  search: z.object({
    mode: z
      .enum(['live_search', 'from_saved_output', 'best_matches', 'most_recent', 'saved_jobs'])
      .default('live_search'),
    query: z.string().default(''),
    queries: z.array(z.string()).default([]),
    sort: z.enum(['recency', 'relevance']).nullable().optional(),
    per_page: z.number().int().nullable().optional(),
    contractor_tier: z.array(z.number().int()).default([]),
    contract_type: z.enum(['hourly', 'fixed']).nullable().optional(),
    proposal_tiers: z.array(z.string()).default([]),
    start_page: z.number().int().min(1).default(1),
    max_pages: z.number().int().min(1).default(1),
    target_jobs: z.number().int().nullable().optional(),
    delay_between_pages_seconds: z.number().nonnegative().optional(),
    deduplicate_by_url: z.boolean().nullable().optional(),
  }),
  filters: z
    .object({
      required_keywords: z.array(z.string()).default([]),
      exclude_keywords: z.array(z.string()).default([]),
      min_score: z.number().int().nullable().optional(),
      max_posted_age_days: z.number().int().nullable().optional(),
      max_proposals: z.number().int().nullable().optional(),
      budget_min: z.number().nullable().optional(),
      budget_max: z.number().nullable().optional(),
    })
    .optional(),
  enrichment: z
    .object({
      enabled: z.boolean().default(false),
      max_jobs_to_enrich: z.number().int().nullable().optional(),
      detail_retries: z.number().int().optional(),
      delay_between_details_seconds: z.number().optional(),
      compute_proposal_scores: z.boolean().optional(),
    })
    .optional(),
});
export type SearchProfileConfig = z.infer<typeof SearchProfileConfigSchema>;

export const SearchProfileEntrySchema = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().default(''),
  config: SearchProfileConfigSchema,
  is_active: z.boolean().default(true),
  last_run_at: z.string().nullable().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});
export type SearchProfileEntry = z.infer<typeof SearchProfileEntrySchema>;

export const EnrichmentModeSchema = z.enum(['full', 'ai_only', 'detail_only']);
export const AIEffortLevelSchema = z.enum(['', 'low', 'medium', 'high', 'xhigh']);

export const EnrichmentConfigSchema = z.object({
  max_batch_size: z.number().int().min(1).max(100),
  default_mode: EnrichmentModeSchema,
  default_force: z.boolean(),
  skip_detail_if_present: z.boolean(),
  require_details: z.boolean(),
  max_concurrency: z.number().int().min(1).max(4),
  default_model: z.string(),
  default_effort: AIEffortLevelSchema,
  confirm_threshold: z.number().int().min(0).max(100),
  wait_timeout_seconds: z.number().int().min(5).max(180),
  web_ui_enabled: z.boolean(),
  web_session_ttl_minutes: z.number().int().min(5).max(10080),
});

export const SearchRunSummarySchema = z.object({
  id: z.number().int(),
  label: z.string(),
  source: z.string(),
  triggered_by: z.string(),
  profile_id: z.number().int().optional(),
  project_keys: z.array(z.string()).default([]),
  queries: z.array(z.string()).default([]),
  criteria: z.unknown().optional(),
  total_scraped: z.number().int().nonnegative(),
  filtered_count: z.number().int().nonnegative(),
  persisted_count: z.number().int().nonnegative(),
  detail_enriched_count: z.number().int().nonnegative(),
  stopped_reason: z.string(),
  created_at: z.string(),
});

export const EnrichmentBatchSummarySchema = z.object({
  id: z.number().int(),
  mode: z.string(),
  triggered_by: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  force: z.boolean(),
  status: z.string(),
  total_count: z.number().int().nonnegative(),
  queued_count: z.number().int().nonnegative(),
  running_count: z.number().int().nonnegative(),
  completed_count: z.number().int().nonnegative(),
  skipped_count: z.number().int().nonnegative(),
  failed_count: z.number().int().nonnegative(),
  canceled_count: z.number().int().nonnegative(),
  total_tokens_used: z.number().int().nonnegative(),
  created_at: z.string(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  updated_at: z.string(),
});

export const EnrichmentBatchItemSchema = z.object({
  id: z.number().int(),
  batch_id: z.number().int(),
  job_id: z.number().int(),
  status: z.string(),
  detail_fetched: z.boolean(),
  llm_invoked: z.boolean(),
  model: z.string().optional(),
  effort: z.string().optional(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  thought_tokens: z.number().int().nonnegative(),
  total_tokens: z.number().int().nonnegative(),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const EnrichmentBatchDetailResponseSchema = z.object({
  batch: EnrichmentBatchSummarySchema,
  items: z.array(EnrichmentBatchItemSchema),
  dashboard_url: z.string().optional(),
});

export const BatchEnrichRequestSchema = z.object({
  job_ids: z.array(z.union([z.number().int().positive(), z.string().min(1)])).min(1),
  mode: EnrichmentModeSchema.optional(),
  force: z.boolean().optional(),
  skip_detail_if_present: z.boolean().optional(),
  require_details: z.boolean().optional(),
  model: z.string().optional(),
  effort: AIEffortLevelSchema.optional(),
  max_concurrency: z.number().int().min(1).max(4).optional(),
  wait: z.boolean().optional(),
  wait_timeout_seconds: z.number().int().min(5).max(180).optional(),
  triggered_by: z.string().optional(),
});

export const ActiveProjectEntrySchema = z.object({
  id: z.number().int(),
  project_key: z.string(),
  slug: z.string(),
  name: z.string(),
  path: z.string(),
  group_name: z.string(),
  activity_tier: z.string(),
  status: z.string(),
  client: z.string(),
  proposal_visibility: z.string(),
  public_alias: z.string(),
  tech_stack: z.array(z.string()).default([]),
  summary: z.string(),
  pinned: z.boolean(),
  last_activity_at: z.string().nullable().optional(),
});
