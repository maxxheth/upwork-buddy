import { z } from 'zod';
import {
  PASSIVE_TAP_EVENT,
  PASSIVE_TAP_READY_EVENT,
  type PassiveTapPayload,
} from './passive-tap-types';
import {
  AuthAndChallengeGuardsConfigSchema,
  type FieldSelectorRule,
  FieldSelectorRuleSchema,
  type SelectorConfig,
} from './selectors';

export { PASSIVE_TAP_EVENT, PASSIVE_TAP_READY_EVENT, type PassiveTapPayload };

export const BridgeErrorCodeSchema = z.enum([
  'EXTENSION_DISCONNECTED',
  'HUMAN_ACTION_REQUIRED',
  'APPROVAL_REQUIRED',
  'DAILY_CAP_EXCEEDED',
  'POLICY_BLOCKED',
  'ALREADY_APPLIED',
  'JOB_UNAVAILABLE',
  'FILL_VERIFICATION_FAILED',
  'INSUFFICIENT_CONNECTS',
  'SCREENING_QUESTIONS_REQUIRED',
  'FORM_VALIDATION_ERROR',
  'PROPOSAL_SUBMIT_UNCONFIRMED',
  'MESSAGE_SEND_UNCONFIRMED',
  'ROOM_NOT_FOUND',
  'ABORTED',
  'TAB_NOT_FOUND',
  'SELECTOR_BROKEN',
  'TIMEOUT',
  'INVALID_PARAMS',
  'INTERNAL_ERROR',
]);
export type BridgeErrorCode = z.infer<typeof BridgeErrorCodeSchema>;

export const BadgeConnectionStateSchema = z.enum([
  'connected',
  'disconnected',
  'auth-required',
  'pending-approval',
]);
export type BadgeConnectionState = z.infer<typeof BadgeConnectionStateSchema>;

export const PolicyModeSchema = z.enum(['confirm_in_ui', 'draft_only', 'auto_with_guardrails']);
export type PolicyMode = z.infer<typeof PolicyModeSchema>;

export const ChallengeTypeSchema = z.enum([
  'login',
  'two_factor',
  'captcha',
  'cloudflare',
  'verification',
  'unknown',
]);
export type ChallengeType = z.infer<typeof ChallengeTypeSchema>;

export const JsonRpcIdSchema = z.union([z.string(), z.number().int()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const WsAuthRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  method: z.literal('auth'),
  params: z.object({
    token: z.string().min(1),
    extension_version: z.string(),
    browser: z.string(),
  }),
});
export type WsAuthRequest = z.infer<typeof WsAuthRequestSchema>;

export const WsAuthSuccessResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  result: z.object({
    ok: z.literal(true),
    session_id: z.string().min(1),
  }),
});
export type WsAuthSuccessResponse = z.infer<typeof WsAuthSuccessResponseSchema>;

export const WsPingSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema.optional(),
  method: z.literal('ping'),
  params: z
    .object({
      upwork_logged_in: z.boolean().optional(),
    })
    .optional(),
});
export type WsPing = z.infer<typeof WsPingSchema>;

export const WsPongSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema.optional(),
  method: z.literal('pong').optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z
    .object({
      pong: z.boolean().optional(),
      ts: z.string().optional(),
    })
    .optional(),
});
export type WsPong = z.infer<typeof WsPongSchema>;

export const WsTaskProgressSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('task.progress'),
  params: z.object({
    request_id: z.string(),
    stage: z.string(),
    current: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    message: z.string().optional(),
  }),
});
export type WsTaskProgress = z.infer<typeof WsTaskProgressSchema>;

export const WsRpcMethodSchema = z.enum([
  'session.status',
  'tabs.list',
  'audit.selectors',
  'diagnostics.capture',
  'diagnostics.test_patch',
  'selectors.reload',
  'jobs.search',
  'jobs.detail',
  'proposal.fill',
  'proposal.submit',
  'proposals.sync',
  'messages.list',
  'messages.get',
  'messages.draft',
  'messages.send',
  'kill_switch.abort',
]);
export type WsRpcMethod = z.infer<typeof WsRpcMethodSchema>;

export const WsRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  timeout_ms: z.number().int().positive().optional(),
});
export type WsRpcRequest = z.infer<typeof WsRpcRequestSchema>;

export const WsRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
  data: z
    .object({
      error_code: BridgeErrorCodeSchema.optional(),
      code: BridgeErrorCodeSchema.optional(),
      details: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
export type WsRpcErrorObject = z.infer<typeof WsRpcErrorObjectSchema>;

export const WsRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  result: z.record(z.string(), z.unknown()).optional(),
  error: WsRpcErrorObjectSchema.optional(),
});
export type WsRpcResponse = z.infer<typeof WsRpcResponseSchema>;

export const SessionStatusResultSchema = z.object({
  ok: z.boolean(),
  extension_connected: z.boolean(),
  extension_version: z.string(),
  browser: z.string(),
  upwork_logged_in: z.boolean(),
  automation_tab_id: z.number().int().nullable(),
  busy: z.boolean(),
  active_request_id: z.string().nullable(),
  kill_switch_active: z.boolean(),
  last_error: z.string().nullable(),
});
export type SessionStatusResult = z.infer<typeof SessionStatusResultSchema>;

export const TabSummarySchema = z.object({
  id: z.number().int(),
  title: z.string(),
  url: z.string(),
  active: z.boolean(),
  automation: z.boolean(),
  is_automation: z.boolean(),
});
export type TabSummary = z.infer<typeof TabSummarySchema>;

export const TabsListResultSchema = z.object({
  tabs: z.array(TabSummarySchema),
});
export type TabsListResult = z.infer<typeof TabsListResultSchema>;

export const KillSwitchAbortResultSchema = z.object({
  aborted: z.boolean(),
  active_request_id: z.string().nullable(),
  reason: z.string(),
});
export type KillSwitchAbortResult = z.infer<typeof KillSwitchAbortResultSchema>;

export const HumanActionRequiredDataSchema = z.object({
  error_code: z.literal('HUMAN_ACTION_REQUIRED'),
  reason: z.string(),
  challenge_type: ChallengeTypeSchema,
  url: z.string().optional(),
});
export type HumanActionRequiredData = z.infer<typeof HumanActionRequiredDataSchema>;

export const PassiveTapPayloadSchema = z.object({
  kind: z.enum(['graphql', 'xhr']),
  url: z.string(),
  operationName: z.string().optional(),
  data: z.unknown(),
  capturedAt: z.string(),
});

export const ContentGuardCheckRequestSchema = z.object({
  type: z.literal('CONTENT_CHECK_GUARDS'),
  guards: AuthAndChallengeGuardsConfigSchema.optional(),
  waitForSelectors: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  scroll: z
    .object({
      steps: z.number().int().positive().optional(),
      intervalMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type ContentGuardCheckRequest = z.infer<typeof ContentGuardCheckRequestSchema>;

export const ContentGuardCheckResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    loggedIn: z.boolean(),
    url: z.string(),
  }),
  z.object({
    ok: z.literal(false),
    errorCode: z.enum(['HUMAN_ACTION_REQUIRED', 'TIMEOUT', 'SELECTOR_BROKEN', 'ABORTED']),
    challengeType: ChallengeTypeSchema.optional(),
    loggedIn: z.boolean().optional(),
    reason: z.string(),
    url: z.string(),
  }),
]);
export type ContentGuardCheckResponse = z.infer<typeof ContentGuardCheckResponseSchema>;

export interface SessionProbeResult {
  url: string;
  pathname: string;
  loggedIn: boolean;
  challengeDetected: boolean;
  challengeType?: ChallengeType;
  challengeReason?: string;
  drawerOpen: boolean;
  isJobDetailPage: boolean;
  hydrated: boolean;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: string;
  source: 'proxy' | 'ws' | 'policy' | 'native' | 'tab';
  action: string;
  detail: string;
  status: 'ok' | 'warn' | 'error';
}

export interface RuntimeStatusSnapshot {
  connectionState: BadgeConnectionState;
  wsConnected: boolean;
  sessionId: string | null;
  lastHeartbeatAt: string | null;
  policyMode: PolicyMode;
  humanActionRequired: boolean;
  activeChallenge: string | null;
  pendingApprovalsCount: number;
  unreadMessagesCount?: number;
  activeTaskCount: number;
  killSwitchActive: boolean;
  automationTabId: number | null;
  lastError: string | null;
  recentActivity: ActivityLogEntry[];
}

export const HookTypeSchema = z.enum([
  'data-test',
  'data-qa',
  'data-cy',
  'data-v',
  'air3-class',
  'id',
]);
export type HookType = z.infer<typeof HookTypeSchema>;

export const AttributeHookSchema = z.object({
  hook_type: HookTypeSchema,
  name: z.string(),
  tag: z.string(),
  sample_text: z.string().nullable().default(null),
  frequency: z.number().int().nonnegative().default(1),
  sample_values: z.array(z.string()).default([]),
});
export type AttributeHook = z.infer<typeof AttributeHookSchema>;

export const JobCardUIBlueprintSchema = z.object({
  container_selector: z.string().default('article.job-tile'),
  total_cards_detected: z.number().int().nonnegative().default(0),
  discovered_hooks: z.record(z.string(), AttributeHookSchema).default({}),
  sample_card_data: z.record(z.string(), z.unknown()).default({}),
});
export type JobCardUIBlueprint = z.infer<typeof JobCardUIBlueprintSchema>;

export const SectionLandmarkSchema = z.object({
  tag: z.string(),
  id: z.string().nullable(),
  class: z.string(),
  data_test: z.string().nullable(),
});
export type SectionLandmark = z.infer<typeof SectionLandmarkSchema>;

export const BlueprintViewTypeSchema = z.enum([
  'search_results',
  'best_matches',
  'most_recent',
  'saved_jobs',
  'job_detail',
  'proposal_apply',
  'proposals_list',
  'messages_rooms',
  'messages_thread',
  'unknown',
]);
export type BlueprintViewType = z.infer<typeof BlueprintViewTypeSchema>;

export const UpWorkPageBlueprintSchema = z.object({
  view_type: BlueprintViewTypeSchema,
  url: z.string(),
  title: z.string(),
  timestamp: z.string(),
  is_authenticated: z.boolean().default(false),
  status_code: z.number().int().default(200),
  proxy_used: z.string().default('Direct'),
  screenshot_path: z.string().nullable().default(null),
  job_card_blueprint: JobCardUIBlueprintSchema.nullable().default(null),
  all_hooks: z.array(AttributeHookSchema).default([]),
  section_landmarks: z.array(SectionLandmarkSchema).default([]),
  captured_xhr_endpoints: z.array(z.string()).default([]),
});
export type UpWorkPageBlueprint = z.infer<typeof UpWorkPageBlueprintSchema>;

export const SelectorHealthStatusSchema = z.enum(['HEALTHY', 'DEGRADED', 'BROKEN', 'FRAGILE']);
export type SelectorHealthStatus = z.infer<typeof SelectorHealthStatusSchema>;

export const SelectorAuditEntrySchema = z.object({
  target_field: z.string(),
  view: z.string(),
  registered_selector: z.string(),
  status: SelectorHealthStatusSchema,
  matched_count: z.number().int().nonnegative(),
  sample_extracted_value: z.unknown().nullable().default(null),
  notes: z.string().default(''),
  suggested_replacement: z.string().nullable().default(null),
});
export type SelectorAuditEntry = z.infer<typeof SelectorAuditEntrySchema>;

export const DiscoveredFieldCandidateSchema = z.object({
  hook_name: z.string(),
  suggested_selector: z.string(),
  sample_text: z.string(),
  element_tag: z.string(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW']),
  notes: z.string().default(''),
});
export type DiscoveredFieldCandidate = z.infer<typeof DiscoveredFieldCandidateSchema>;

export const BaselineHookDiffSchema = z.object({
  hook_name: z.string(),
  hook_type: z.string(),
  change_type: z.enum(['REMOVED', 'FREQUENCY_DROPPED', 'ADDED']),
  baseline_frequency: z.number().int().nonnegative().default(0),
  current_frequency: z.number().int().nonnegative().default(0),
  notes: z.string().default(''),
});
export type BaselineHookDiff = z.infer<typeof BaselineHookDiffSchema>;

export const DriftAuditReportSchema = z.object({
  timestamp: z.string(),
  url: z.string(),
  view_type: z.string(),
  is_authenticated: z.boolean(),
  healthy_selectors_count: z.number().int().nonnegative(),
  degraded_selectors_count: z.number().int().nonnegative(),
  broken_selectors_count: z.number().int().nonnegative(),
  fragile_selectors_count: z.number().int().nonnegative(),
  audits: z.array(SelectorAuditEntrySchema),
  discovered_candidates: z.array(DiscoveredFieldCandidateSchema),
  breaking_changes_detected: z.array(z.string()),
  baseline_diffs: z.array(BaselineHookDiffSchema),
});
export type DriftAuditReport = z.infer<typeof DriftAuditReportSchema>;

export const RepetitivePatternCandidateSchema = z.object({
  pattern_name: z.string(),
  nearest_heading: z.string().nullable().default(null),
  container_selector: z.string(),
  item_selector: z.string(),
  instance_count: z.number().int().nonnegative(),
  sample_items: z.array(z.string()).default([]),
});
export type RepetitivePatternCandidate = z.infer<typeof RepetitivePatternCandidateSchema>;

export const RankedSelectorCandidateSchema = z.object({
  selector: z.string(),
  stability_score: z.number(),
  matched_count: z.number().int().nonnegative(),
  sample_value: z.unknown().nullable().default(null),
  strategy: z.string(),
  is_fragile: z.boolean().default(false),
  reason: z.string().default(''),
});
export type RankedSelectorCandidate = z.infer<typeof RankedSelectorCandidateSchema>;

export const BrokenFieldDiagnosisSchema = z.object({
  field: z.string(),
  view: z.string(),
  status: SelectorHealthStatusSchema,
  registered_selector: z.string(),
  matched_count: z.number().int().nonnegative(),
  notes: z.string().default(''),
  nearest_heading: z.string().nullable().default(null),
  anchor_html: z.string().default(''),
  candidates: z.array(RankedSelectorCandidateSchema).default([]),
});
export type BrokenFieldDiagnosis = z.infer<typeof BrokenFieldDiagnosisSchema>;

export interface PrunedLandmarkNode {
  landmark: string;
  tag: string;
  id: string | null;
  data_test: string | null;
  classes: string[];
  text_preview: string;
  child_count: number;
  patterns: RepetitivePatternCandidate[];
  children: PrunedLandmarkNode[];
}

export const PrunedLandmarkNodeSchema: z.ZodType<PrunedLandmarkNode> = z.lazy(() =>
  z.object({
    landmark: z.string(),
    tag: z.string(),
    id: z.string().nullable().default(null),
    data_test: z.string().nullable().default(null),
    classes: z.array(z.string()).default([]),
    text_preview: z.string().default(''),
    child_count: z.number().int().nonnegative().default(0),
    patterns: z.array(RepetitivePatternCandidateSchema).default([]),
    children: z.array(PrunedLandmarkNodeSchema).default([]),
  }),
);

export const PassiveGraphqlSummarySchema = z.object({
  operation_name: z.string(),
  url: z.string(),
  top_keys: z.array(z.string()).default([]),
});
export type PassiveGraphqlSummary = z.infer<typeof PassiveGraphqlSummarySchema>;

export const DiagnosticScopeSchema = z.enum(['auto', 'drawer', 'page']);
export type DiagnosticScope = z.infer<typeof DiagnosticScopeSchema>;

export const UiDiagnosticCaptureSchema = z.object({
  capture_uid: z.string().optional(),
  captured_at: z.string(),
  url: z.string(),
  title: z.string(),
  view_type: z.string(),
  scope: DiagnosticScopeSchema.default('auto'),
  is_authenticated: z.boolean().default(false),
  overall_status: SelectorHealthStatusSchema,
  redact_pii: z.boolean().default(true),
  audit_report: DriftAuditReportSchema,
  blueprint: UpWorkPageBlueprintSchema,
  landmarks: z.array(PrunedLandmarkNodeSchema).default([]),
  repetitive_patterns: z.array(RepetitivePatternCandidateSchema).default([]),
  broken_fields: z.array(BrokenFieldDiagnosisSchema).default([]),
  pruned_html: z.string().default(''),
  passive_graphql_ops: z.array(PassiveGraphqlSummarySchema).default([]),
  screenshot_data_url: z.string().optional(),
});
export type UiDiagnosticCapture = z.infer<typeof UiDiagnosticCaptureSchema>;

export const SelectorPatchTestRequestSchema = z.object({
  view: z.string().min(1),
  field: z.string().min(1),
  rule: FieldSelectorRuleSchema,
  capture_id: z.string().optional(),
  use_active_tab: z.boolean().optional(),
  pruned_html: z.string().optional(),
});
export type SelectorPatchTestRequest = z.infer<typeof SelectorPatchTestRequestSchema>;

export const SelectorPatchFieldSummarySchema = z.object({
  status: SelectorHealthStatusSchema,
  matched_count: z.number().int().nonnegative(),
  sample_value: z.unknown().nullable().default(null),
  matched_selector: z.string().nullable().default(null),
});
export type SelectorPatchFieldSummary = z.infer<typeof SelectorPatchFieldSummarySchema>;

export const SelectorPatchRegressionSchema = z.object({
  field: z.string(),
  before_status: SelectorHealthStatusSchema,
  after_status: SelectorHealthStatusSchema,
  reason: z.string().default(''),
});
export type SelectorPatchRegression = z.infer<typeof SelectorPatchRegressionSchema>;

export const SelectorPatchTestResultSchema = z.object({
  ok: z.boolean(),
  view: z.string(),
  field: z.string(),
  matched_count: z.number().int().nonnegative(),
  sample_value: z.unknown().nullable().default(null),
  status: SelectorHealthStatusSchema,
  regressions: z.array(SelectorPatchRegressionSchema).default([]),
  before_summary: SelectorPatchFieldSummarySchema,
  after_summary: SelectorPatchFieldSummarySchema,
  yaml_diff: z.string().optional(),
});
export type SelectorPatchTestResult = z.infer<typeof SelectorPatchTestResultSchema>;

export const SidePanelTabSchema = z.enum([
  'pipeline',
  'approvals',
  'messages',
  'activity',
  'agents',
  'selectors',
]);

export const BackgroundCommandMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('API_PROXY_REQUEST'),
    url: z.string(),
    method: z.string().default('GET'),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  }),
  z.object({ type: z.literal('BG_GET_STATUS') }),
  z.object({ type: z.literal('GET_RUNTIME_STATUS') }),
  z.object({ type: z.literal('BG_WS_RECONNECT') }),
  z.object({
    type: z.literal('PAIR_AND_RECONNECT'),
    apiBaseUrl: z.string(),
    apiToken: z.string(),
    pacingSeconds: z.number().nonnegative().optional(),
    jitterRatio: z.number().min(0).max(0.9).optional(),
  }),
  z.object({
    type: z.literal('TEST_CONNECTION'),
    apiBaseUrl: z.string(),
    apiToken: z.string(),
  }),
  z.object({
    type: z.literal('BG_NATIVE_HOST_COMMAND'),
    command: z.enum(['ping', 'status', 'start_daemon', 'get_token']),
  }),
  z.object({ type: z.literal('NATIVE_HOST_PING') }),
  z.object({ type: z.literal('NATIVE_HOST_START_SERVER') }),
  z.object({ type: z.literal('BG_KILL_SWITCH'), reason: z.string().optional() }),
  z.object({ type: z.literal('TRIGGER_KILL_SWITCH'), reason: z.string().optional() }),
  z.object({
    type: z.literal('BG_SET_PENDING_APPROVALS'),
    count: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('BG_UPDATE_UNREAD_POLL_CONFIG'),
    enabled: z.boolean(),
    intervalMinutes: z.number().min(1).max(1440).optional(),
  }),
  z.object({ type: z.literal('BG_POLL_MESSAGES') }),
  z.object({
    type: z.literal('BG_SELECTORS_GET'),
    forceRefresh: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('BG_RUN_SEARCH'),
    params: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('BG_RUN_DETAIL_ENRICH'),
    params: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('BG_RUN_SELECTOR_AUDIT'),
    view: z.string().optional(),
    url: z.string().optional(),
    updateBaseline: z.boolean().optional(),
    useActiveTab: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('BG_CAPTURE_UI_DIAGNOSTIC'),
    useActiveTab: z.boolean().optional(),
    view: z.string().optional(),
    url: z.string().optional(),
    scope: DiagnosticScopeSchema.optional(),
    includeScreenshot: z.boolean().optional(),
    redactPii: z.boolean().optional(),
    brokenFields: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('BG_TEST_SELECTOR_PATCH'),
    view: z.string().min(1),
    field: z.string().min(1),
    rule: FieldSelectorRuleSchema,
    captureId: z.string().optional(),
    useActiveTab: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('BG_APPLY_SELECTOR_PATCH'),
    view: z.string().min(1),
    field: z.string().min(1),
    rule: FieldSelectorRuleSchema,
    reason: z.string().optional(),
    exportFixture: z.boolean().optional(),
    captureId: z.string().optional(),
    mode: z.enum(['prepend', 'replace']).optional(),
  }),
  z.object({
    type: z.literal('BG_ROLLBACK_SELECTOR_PATCH'),
    backupFile: z.string().optional(),
  }),
  z.object({
    type: z.literal('OPEN_SIDEPANEL'),
    windowId: z.number().int().optional(),
    tabId: z.number().int().optional(),
    tab: SidePanelTabSchema.optional(),
  }),
  z.object({
    type: z.literal('OPEN_JOBS_DASHBOARD'),
    queryString: z.string().optional(),
    runId: z.number().int().positive().optional(),
    fit: z.string().optional(),
    q: z.string().optional(),
    batchId: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal('BG_GET_PENDING_SIDEPANEL_TAB') }),
  z.object({
    type: z.literal('PASSIVE_TAP_PAYLOAD'),
    kind: z.enum(['graphql', 'xhr']),
    url: z.string(),
    operationName: z.string().optional(),
    data: z.unknown(),
    capturedAt: z.string(),
  }),
]);
export type BackgroundCommandMessage = z.infer<typeof BackgroundCommandMessageSchema>;

export interface ContentAuditSelectorsRequest {
  type: 'CONTENT_AUDIT_SELECTORS';
  view?: string;
  selectorConfig?: SelectorConfig;
  baseline?: UpWorkPageBlueprint | null;
  isAuthenticated?: boolean;
  capturedXhrEndpoints?: string[];
}

export interface ContentScrapeSearchRequest {
  type: 'CONTENT_SCRAPE_SEARCH';
  source: 'search' | 'best_matches' | 'most_recent' | 'saved_jobs';
  query?: string;
  selectorConfig?: SelectorConfig;
}

export interface ContentScrapeDetailRequest {
  type: 'CONTENT_SCRAPE_DETAIL';
  url?: string;
  requireDrawer?: boolean;
  selectorConfig?: SelectorConfig;
}

export interface ContentProposalFillRequest {
  type: 'CONTENT_PROPOSAL_FILL';
  params: Record<string, unknown>;
  selectorConfig?: SelectorConfig;
}

export interface ContentProposalSubmitRequest {
  type: 'CONTENT_PROPOSAL_SUBMIT';
  params: Record<string, unknown>;
  selectorConfig?: SelectorConfig;
}

export interface ContentProposalsSyncRequest {
  type: 'CONTENT_PROPOSALS_SYNC';
  selectorConfig?: SelectorConfig;
}

export interface ContentMessagesListRequest {
  type: 'CONTENT_MESSAGES_LIST';
  selectorConfig?: SelectorConfig;
}

export interface ContentMessagesGetRequest {
  type: 'CONTENT_MESSAGES_GET';
  room_id: string;
  selectorConfig?: SelectorConfig;
}

export interface ContentMessagesDraftRequest {
  type: 'CONTENT_MESSAGES_DRAFT';
  room_id: string;
  body: string;
  selectorConfig?: SelectorConfig;
}

export interface ContentMessagesSendRequest {
  type: 'CONTENT_MESSAGES_SEND';
  room_id: string;
  body?: string;
  selectorConfig?: SelectorConfig;
}

export interface ContentCaptureUiDiagnosticRequest {
  type: 'CONTENT_CAPTURE_UI_DIAGNOSTIC';
  view?: string;
  scope?: DiagnosticScope;
  redactPii?: boolean;
  brokenFields?: string[];
  selectorConfig?: SelectorConfig;
  baseline?: UpWorkPageBlueprint | null;
  isAuthenticated?: boolean;
  passivePayloads?: PassiveTapPayload[];
}

export interface ContentTestSelectorPatchRequest {
  type: 'CONTENT_TEST_SELECTOR_PATCH';
  view: string;
  field: string;
  rule: FieldSelectorRule;
  selectorConfig?: SelectorConfig;
  prunedHtml?: string;
}

export interface ContentSelectorsReloadedMessage {
  type: 'CONTENT_SELECTORS_RELOADED';
  selectorConfig: SelectorConfig;
}

export type ContentRuntimeMessage =
  | ContentGuardCheckRequest
  | ContentAuditSelectorsRequest
  | ContentCaptureUiDiagnosticRequest
  | ContentTestSelectorPatchRequest
  | ContentSelectorsReloadedMessage
  | ContentScrapeSearchRequest
  | ContentScrapeDetailRequest
  | ContentProposalFillRequest
  | ContentProposalSubmitRequest
  | ContentProposalsSyncRequest
  | ContentMessagesListRequest
  | ContentMessagesGetRequest
  | ContentMessagesDraftRequest
  | ContentMessagesSendRequest
  | { type: 'CONTENT_PROBE_SESSION' }
  | { type: 'CONTENT_CHECK_PROPOSAL_CONFIRMATION' }
  | { type: 'CONTENT_CHECK_HYDRATION'; selector?: string; timeoutMs?: number }
  | { type: 'CONTENT_EXTRACT_AND_ANALYZE'; action: 'save' | 'analyze' }
  | { type: 'CONTENT_KILL_ABORT'; reason?: string };
