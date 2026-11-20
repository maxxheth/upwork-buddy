export type AuthState = 'authenticated' | 'logged_out';

export type ChallengeMode = 'none' | 'login' | 'two_factor' | 'captcha' | 'cloudflare';

export type DriftMode =
  | 'healthy'
  | 'clean_no_fragile'
  | 'fragile'
  | 'degraded_fallback'
  | 'degraded_low_cards'
  | 'degraded_empty_text'
  | 'broken_typo_fixed'
  | 'broken_vue_hash'
  | 'broken_missing'
  | 'broken_search'
  | 'broken_v2_card'
  | 'broken_detail'
  | 'broken_detail_skills'
  | 'mutated_drift'
  | 'unmapped_auth';

export interface InjectedUnreadMessage {
  roomId: string;
  sender: string;
  body: string;
  timestamp?: string;
}

export interface MockServerConfig {
  authState: AuthState;
  challenge: ChallengeMode;
  challengeOnPath?: string | null;
  driftMode: DriftMode;
  passiveTapEnabled: boolean;
  omitDomClientMetrics: boolean;
  lockApplyBid: boolean;
  rateLimitRemaining: number;
  delayMs: number;
  delayMsByPath: Record<string, number>;
  totalSearchPages: number;
  unreadMessages: InjectedUnreadMessage[];
}

export interface RecordedRequest {
  method: string;
  path: string;
  pathname: string;
  search: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string;
  timestamp: number;
  timestampMs: number;
  isPageNavigation: boolean;
}

export interface SubmittedProposalRecord {
  proposalId: string;
  jobId: string;
  bidType: 'hourly' | 'fixed';
  bidAmount: string;
  milestones: Array<{ description: string; dueDate: string; amount: string }>;
  coverLetter: string;
  screeningAnswers: string[];
  boostConnects: number;
  submittedAt: string;
}

export interface MockMessageEntry {
  id: string;
  sender: string;
  body: string;
  timestamp: string;
  attachments?: string[];
  interviewCard?: string;
  offerCard?: string;
}

export interface MockRoomState {
  roomId: string;
  aliases: string[];
  clientName: string;
  clientCompany: string;
  jobId: string;
  jobTitle: string;
  unreadCount: number;
  messages: MockMessageEntry[];
}

export interface MockServerStateSnapshot {
  config: MockServerConfig;
  submittedProposals: SubmittedProposalRecord[];
  rooms: Record<string, MockRoomState>;
}

export interface MockServerHandle {
  port: number;
  baseUrl: string;
  close(): Promise<void>;
}
