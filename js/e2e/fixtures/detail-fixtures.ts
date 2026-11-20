import type { AuthState, DriftMode } from '../server/mock-types.ts';
import { escapeHtml, renderSharedAuthenticatedNav } from './challenge-fixtures.ts';
import { renderUnmappedAuthHooks } from './drift-fixtures.ts';

export interface ScreeningQuestionSpec {
  prompt: string;
  required: boolean;
}

export interface JobDetailSpec {
  id: string; // with leading ~, e.g. "~022115332344639171"
  slug: string;
  title: string;
  posted: string;
  descriptionHtml: string;
  bidType: 'hourly' | 'fixed';
  hourlyMin?: string;
  hourlyMax?: string;
  fixedAmount?: string;
  omitBudget?: boolean;
  experienceLevel: string;
  duration: string;
  hoursPerWeek?: string;
  connectsRequired?: number;
  skills: string[];
  attachments: string[];
  screeningQuestions: ScreeningQuestionSpec[];
  qualifications: Array<{ label: string; value: string }>;
  proposalsTier?: string;
  lastViewed?: string;
  interviewing?: number;
  invitesSent?: number;
  unansweredInvites?: number;
  paymentVerified: boolean;
  clientCountry: string;
  clientRating?: string;
  clientReviews?: number;
  clientSpent?: string;
  clientHires?: number;
  clientHireRate?: string;
  clientAvgHourly?: string;
  rateIncreaseEnabled?: boolean;
  errorVariant?: 'not_found' | 'private' | 'soft_404';
}

const DEFAULT_QUALIFICATIONS: Array<{ label: string; value: string }> = [
  { label: 'Job Success Score', value: 'At least 90%' },
  { label: 'English level', value: 'Fluent' },
  { label: 'Location', value: 'United States' },
];

const RICH_SEO_DESCRIPTION = [
  'Summary We need an expert <span class="highlight">WordPress</span> &amp; Elementor developer ',
  'to lead a comprehensive technical SEO audit, Core Web Vitals optimization, schema markup ',
  'rollout, and custom Go/PostgreSQL telemetry integration for our multi-location HVAC site.',
  '<br>Key deliverables include Lighthouse 95+ performance tuning, clean canonical routing, ',
  'automated structured data generation, Playwright regression coverage, and Dockerized staging ',
  'deployments with TypeScript tooling.<br><br>See <a href="https://example.com">example.com</a> ',
  'for our current site architecture and benchmark metrics.',
].join('');

export const JOB_DETAIL_REGISTRY: Record<string, JobDetailSpec> = {
  '~022115332344639171': {
    id: '~022115332344639171',
    slug: 'On-Page-SEO-Expert-Audit-WordPress-Elementor',
    title: 'On-Page SEO Expert Needed — Audit + WordPress/Elementor Implementation',
    posted: 'Posted 2 hours ago',
    descriptionHtml: RICH_SEO_DESCRIPTION,
    bidType: 'fixed',
    fixedAmount: '$1,500.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 12,
    skills: [
      'WordPress',
      'Elementor',
      'SEO',
      'Go',
      'PostgreSQL',
      'Playwright',
      'TypeScript',
      'Docker',
    ],
    attachments: ['spec.pdf'],
    screeningQuestions: [
      {
        prompt: 'Describe a similar WordPress Core Web Vitals audit you completed.',
        required: true,
      },
      {
        prompt: 'What is your weekly availability?',
        required: false,
      },
    ],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    lastViewed: '1 hour ago',
    interviewing: 2,
    invitesSent: 4,
    unansweredInvites: 1,
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.95 out of 5',
    clientReviews: 48,
    clientSpent: '$120K total spent',
    clientHires: 52,
    clientHireRate: '85% hire rate',
    clientAvgHourly: '$55.00/hr avg hourly rate paid',
  },
  '~022115332344639172': {
    id: '~022115332344639172',
    slug: 'WordPress-Landing-Page-Cleanup',
    title: 'WordPress Landing Page Cleanup',
    posted: 'Posted 6 hours ago',
    descriptionHtml:
      'Summary Clean up an existing landing page layout and fix responsive CSS issues.',
    bidType: 'fixed',
    fixedAmount: '$250.00',
    experienceLevel: 'Intermediate',
    duration: 'Less than 1 month',
    hoursPerWeek: 'Less than 30 hrs/week',
    connectsRequired: 8,
    skills: ['WordPress', 'CSS'],
    attachments: [],
    screeningQuestions: [],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: '5 to 10',
    lastViewed: '2 hours ago',
    interviewing: 0,
    invitesSent: 1,
    unansweredInvites: 0,
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.7 out of 5',
    clientReviews: 12,
    clientSpent: '$15K total spent',
    clientHires: 10,
    clientHireRate: '80% hire rate',
  },
  '~022115332344639173': {
    id: '~022115332344639173',
    slug: 'Zero-Budget-Placeholder-Job',
    title: 'Zero Budget Placeholder Job',
    posted: 'Posted 1 day ago',
    descriptionHtml: 'Summary Job posted with explicit zero fixed budget for edge testing.',
    bidType: 'fixed',
    fixedAmount: '$0.00',
    experienceLevel: 'Entry level',
    duration: 'Less than 1 month',
    hoursPerWeek: 'Less than 30 hrs/week',
    connectsRequired: 4,
    skills: ['HTML'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: '10 to 15',
    paymentVerified: true,
    clientCountry: 'Canada',
    clientRating: '4.5 out of 5',
    clientReviews: 5,
    clientSpent: '$2K total spent',
    clientHires: 3,
    clientHireRate: '60% hire rate',
  },
  '~022115332344639174': {
    id: '~022115332344639174',
    slug: 'Partial-Fields-Detail-Job',
    title: 'Partial Fields Detail Job',
    posted: 'Posted 5 hours ago',
    descriptionHtml:
      'Summary Detail fixture intentionally omitting proposals, hours_per_week, client_rating, client_spent, and budget.',
    bidType: 'fixed',
    omitBudget: true,
    experienceLevel: 'Intermediate',
    duration: '1 to 3 months',
    connectsRequired: 8,
    skills: ['Go', 'TypeScript'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    paymentVerified: false,
    clientCountry: 'United Kingdom',
  },
  '~022115332344639180': {
    id: '~022115332344639180',
    slug: 'Senior-Go-Systems-Consultant-Hourly',
    title: 'Senior Go Systems Consultant (Hourly)',
    posted: 'Posted 4 hours ago',
    descriptionHtml:
      'Summary Seeking a senior Go systems consultant for ongoing backend performance tuning and telemetry work.',
    bidType: 'hourly',
    hourlyMin: '$85.00',
    experienceLevel: 'Expert',
    duration: '3 to 6 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 10,
    skills: ['Go', 'PostgreSQL', 'Docker'],
    attachments: ['architecture-overview.pdf'],
    screeningQuestions: [
      { prompt: 'Share a Go concurrency bottleneck you diagnosed in production.', required: true },
    ],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    lastViewed: '30 minutes ago',
    interviewing: 1,
    invitesSent: 2,
    unansweredInvites: 0,
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 20,
    clientSpent: '$60K total spent',
    clientHires: 22,
    clientHireRate: '90% hire rate',
    rateIncreaseEnabled: true,
  },
  '~022111887415567641941': {
    id: '~022111887415567641941',
    slug: 'Python-FastAPI-Microservices-Architect',
    title: 'Python FastAPI Microservices Architect',
    posted: 'Posted 3 hours ago',
    descriptionHtml:
      'Summary Build scalable REST APIs using FastAPI and PostgreSQL with clean async boundaries and CI coverage.',
    bidType: 'fixed',
    fixedAmount: '$2,500.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 12,
    skills: ['Python', 'FastAPI', 'PostgreSQL'],
    attachments: ['fastapi-spec.pdf'],
    screeningQuestions: [
      { prompt: 'Describe your experience with async SQLAlchemy/PostgreSQL.', required: true },
      { prompt: 'Can you start this week?', required: false },
    ],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    lastViewed: '45 minutes ago',
    interviewing: 1,
    invitesSent: 3,
    unansweredInvites: 1,
    paymentVerified: true,
    clientCountry: 'Canada',
    clientRating: '5.0 out of 5',
    clientReviews: 18,
    clientSpent: '10k total spent',
    clientHires: 12,
    clientHireRate: '90% hire rate',
  },
  '~022111887415567641942': {
    id: '~022111887415567641942',
    slug: 'Full-Website-Migration-GoDaddy-Host-WordPress-CDN',
    title: 'Full Website Migration (GoDaddy to WordPress)',
    posted: 'Posted yesterday',
    descriptionHtml:
      'Summary <span class="highlight">WordPress</span> site needs moving off GoDaddy hosting with zero DNS downtime and Cloudflare CDN hardening.',
    bidType: 'fixed',
    fixedAmount: '$1,000.00',
    experienceLevel: 'Intermediate',
    duration: 'Less than 1 month',
    hoursPerWeek: 'Less than 30 hrs/week',
    connectsRequired: 8,
    skills: ['WordPress', 'Cloudflare'],
    attachments: [],
    screeningQuestions: [
      { prompt: 'How do you verify DNS propagation before cutover?', required: true },
    ],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    lastViewed: '2 hours ago',
    interviewing: 0,
    invitesSent: 2,
    unansweredInvites: 1,
    paymentVerified: true,
    clientCountry: 'United Kingdom',
    clientRating: '4.8 out of 5',
    clientReviews: 15,
    clientSpent: '$12K total spent',
    clientHires: 6,
    clientHireRate: '75% hire rate',
  },
  '~022111887415567641944': {
    id: '~022111887415567641944',
    slug: 'Legacy-Placeholder-Budget-Task',
    title: 'Legacy Placeholder Budget Task',
    posted: 'Posted 2 weeks ago',
    descriptionHtml: 'Summary Placeholder zero budget task for filter edge case testing.',
    bidType: 'fixed',
    fixedAmount: '$0.00',
    experienceLevel: 'Entry level',
    duration: 'Less than 1 month',
    connectsRequired: 4,
    skills: ['HTML'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: '50+',
    paymentVerified: false,
    clientCountry: 'Australia',
    clientRating: '4.2 out of 5',
    clientReviews: 4,
    clientSpent: '$0 total spent',
    clientHires: 0,
    clientHireRate: '0% hire rate',
  },
  '~022111887415567642001': {
    id: '~022111887415567642001',
    slug: 'Senior-Go-PostgreSQL-Backend-Engineer',
    title: 'Senior Go & PostgreSQL Backend Engineer',
    posted: 'Posted 4 hours ago',
    descriptionHtml:
      'Summary Build reliable Go services backed by PostgreSQL and Docker with clean observability.',
    bidType: 'hourly',
    hourlyMin: '$80.00',
    hourlyMax: '$110.00',
    experienceLevel: 'Expert',
    duration: '3 to 6 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 12,
    skills: ['Go', 'PostgreSQL', 'Docker'],
    attachments: [],
    screeningQuestions: [],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 24,
    clientSpent: '$45K total spent',
    clientHires: 18,
    clientHireRate: '88% hire rate',
  },
  '~022111887415567642002': {
    id: '~022111887415567642002',
    slug: 'AI-Agent-Integration-MCP-TypeScript',
    title: 'AI Agent Integration with MCP & TypeScript',
    posted: 'Posted 1 hour ago',
    descriptionHtml:
      'Summary Integrate typed MCP tool servers with TypeScript browser extensions and automated verification.',
    bidType: 'fixed',
    fixedAmount: '$1,800.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 10,
    skills: ['TypeScript', 'AI', 'Node.js'],
    attachments: [],
    screeningQuestions: [],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: '5 to 10',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.95 out of 5',
    clientReviews: 19,
    clientSpent: '$30K total spent',
    clientHires: 14,
    clientHireRate: '86% hire rate',
  },
  '~022111887415567642003': {
    id: '~022111887415567642003',
    slug: 'WordPress-Multisite-Page-3-Optimization',
    title: 'WordPress Multisite Performance Tuning (Page 3)',
    posted: 'Posted 5 hours ago',
    descriptionHtml: 'Summary Optimize database queries across a WordPress multisite network.',
    bidType: 'fixed',
    fixedAmount: '$1,100.00',
    experienceLevel: 'Intermediate',
    duration: '1 to 3 months',
    connectsRequired: 8,
    skills: ['WordPress', 'MySQL'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: '5 to 10',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.8 out of 5',
    clientReviews: 11,
    clientSpent: '$18K total spent',
    clientHires: 8,
    clientHireRate: '75% hire rate',
  },
  '~022111887415567642004': {
    id: '~022111887415567642004',
    slug: 'WordPress-Custom-Plugin-Page-4',
    title: 'WordPress Custom REST Plugin Build (Page 4)',
    posted: 'Posted 7 hours ago',
    descriptionHtml: 'Summary Develop a lightweight WordPress REST integration plugin.',
    bidType: 'fixed',
    fixedAmount: '$1,300.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    connectsRequired: 10,
    skills: ['WordPress', 'PHP'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'Canada',
    clientRating: '4.9 out of 5',
    clientReviews: 9,
    clientSpent: '$22K total spent',
    clientHires: 7,
    clientHireRate: '80% hire rate',
  },
  '~022111887415567642005': {
    id: '~022111887415567642005',
    slug: 'WordPress-Security-Hardening-Page-5',
    title: 'WordPress Security & WAF Hardening (Page 5)',
    posted: 'Posted 8 hours ago',
    descriptionHtml: 'Summary Harden WordPress headers, CSP, and Cloudflare WAF rules.',
    bidType: 'fixed',
    fixedAmount: '$950.00',
    experienceLevel: 'Intermediate',
    duration: 'Less than 1 month',
    connectsRequired: 8,
    skills: ['WordPress', 'Security'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: '5 to 10',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.7 out of 5',
    clientReviews: 10,
    clientSpent: '$16K total spent',
    clientHires: 6,
    clientHireRate: '70% hire rate',
  },
  '~022111887415567643001': {
    id: '~022111887415567643001',
    slug: 'Elementor-Custom-Widget-Kit',
    title: 'Elementor Custom Widget Kit Development',
    posted: 'Posted 2 hours ago',
    descriptionHtml: 'Summary Build reusable Elementor widgets with clean responsive CSS.',
    bidType: 'fixed',
    fixedAmount: '$1,400.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    connectsRequired: 10,
    skills: ['Elementor', 'WordPress', 'CSS'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 14,
    clientSpent: '$28K total spent',
    clientHires: 11,
    clientHireRate: '82% hire rate',
  },
  '~022111887415567643002': {
    id: '~022111887415567643002',
    slug: 'Elementor-Speed-Audit-LCP-Fix',
    title: 'Elementor Speed Audit & LCP Fix',
    posted: 'Posted 3 hours ago',
    descriptionHtml: 'Summary Reduce Largest Contentful Paint on an Elementor Pro storefront.',
    bidType: 'fixed',
    fixedAmount: '$900.00',
    experienceLevel: 'Intermediate',
    duration: 'Less than 1 month',
    connectsRequired: 8,
    skills: ['Elementor', 'Performance'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: '5 to 10',
    paymentVerified: true,
    clientCountry: 'United Kingdom',
    clientRating: '4.8 out of 5',
    clientReviews: 8,
    clientSpent: '$14K total spent',
    clientHires: 5,
    clientHireRate: '75% hire rate',
  },
  '~022112225892746435112': {
    id: '~022112225892746435112',
    slug: 'On-Off-WordPress-Host-Server',
    title: 'On/Off WordPress & Host Server Setup',
    posted: 'Posted 1 hour ago',
    descriptionHtml: 'Summary Configure On/Off WordPress & Host Server caching and monitoring.',
    bidType: 'fixed',
    fixedAmount: '$1,250.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    connectsRequired: 10,
    skills: ['WordPress', 'Linux'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 20,
    clientSpent: '$40K total spent',
    clientHires: 15,
    clientHireRate: '85% hire rate',
  },
  '~030100000000000000001': {
    id: '~030100000000000000001',
    slug: 'Senior-Golang-Microservices-Engineer',
    title: 'Senior Golang Microservices Engineer',
    posted: 'Posted 1 hour ago',
    descriptionHtml:
      'Summary Architect and maintain production Golang microservices backed by PostgreSQL with comprehensive test suites and observability.',
    bidType: 'fixed',
    fixedAmount: '$1,200.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 10,
    skills: ['Go', 'Golang', 'PostgreSQL'],
    attachments: [],
    screeningQuestions: [],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 30,
    clientSpent: '$80K total spent',
    clientHires: 25,
    clientHireRate: '90% hire rate',
  },
  '~030100000000000000002': {
    id: '~030100000000000000002',
    slug: 'Golang-Script-Fix',
    title: 'Golang Script Fix',
    posted: 'Posted 3 hours ago',
    descriptionHtml: 'Summary Fix a small Golang CLI parsing bug.',
    bidType: 'fixed',
    fixedAmount: '$80.00',
    experienceLevel: 'Entry level',
    duration: 'Less than 1 month',
    connectsRequired: 4,
    skills: ['Go', 'Golang'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: '5 to 10',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.6 out of 5',
    clientReviews: 6,
    clientSpent: '$5K total spent',
    clientHires: 4,
    clientHireRate: '70% hire rate',
  },
  '~030100000000000000003': {
    id: '~030100000000000000003',
    slug: 'Golang-Placeholder-Task',
    title: 'Golang Placeholder Task',
    posted: 'Posted 5 hours ago',
    descriptionHtml: 'Summary Placeholder Golang task with explicit $0.00 budget on search card.',
    bidType: 'fixed',
    fixedAmount: '$0.00',
    experienceLevel: 'Intermediate',
    duration: 'Less than 1 month',
    connectsRequired: 4,
    skills: ['Go', 'Golang'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: '10 to 15',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.5 out of 5',
    clientReviews: 4,
    clientSpent: '$3K total spent',
    clientHires: 2,
    clientHireRate: '50% hire rate',
  },
  '~033000000000000000001': {
    id: '~033000000000000000001',
    slug: 'Full-Stack-Go-TypeScript-Extension-Developer',
    title: 'Full-Stack Go & TypeScript Extension Developer',
    posted: 'Posted 1 hour ago',
    descriptionHtml:
      'Summary Build a WXT MV3 browser extension paired with a Go + PostgreSQL backend service, Playwright verification, and clean DOM adapters.',
    bidType: 'hourly',
    hourlyMin: '$90.00',
    hourlyMax: '$115.00',
    experienceLevel: 'Expert',
    duration: '3 to 6 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 10,
    skills: ['Go', 'TypeScript', 'PostgreSQL'],
    attachments: ['extension-architecture.pdf'],
    screeningQuestions: [
      { prompt: 'Describe an MV3 extension you shipped.', required: true },
      { prompt: 'Share your PostgreSQL indexing approach.', required: true },
    ],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    lastViewed: '20 minutes ago',
    interviewing: 1,
    invitesSent: 2,
    unansweredInvites: 0,
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.95 out of 5',
    clientReviews: 35,
    clientSpent: '$95K total spent',
    clientHires: 28,
    clientHireRate: '90% hire rate',
  },
  '~033000000000000000002': {
    id: '~033000000000000000002',
    slug: 'Playwright-E2E-Automation-Specialist',
    title: 'Playwright E2E Automation Specialist',
    posted: 'Posted 2 hours ago',
    descriptionHtml: 'Summary Build deterministic Playwright E2E test suites for web apps.',
    bidType: 'fixed',
    fixedAmount: '$1,200.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 8,
    skills: ['Playwright', 'TypeScript'],
    attachments: [],
    screeningQuestions: [],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 16,
    clientSpent: '$38K total spent',
    clientHires: 12,
    clientHireRate: '85% hire rate',
  },
  '~033000000000000000003': {
    id: '~033000000000000000003',
    slug: 'Realtime-WebSocket-Gateway-Engineer',
    title: 'Realtime WebSocket Gateway Engineer',
    posted: 'Posted 5 minutes ago',
    descriptionHtml: 'Summary Design a low-latency Go WebSocket bridge with heartbeat recovery.',
    bidType: 'fixed',
    fixedAmount: '$1,750.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    connectsRequired: 10,
    skills: ['Go', 'WebSockets'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'Germany',
    clientRating: '4.9 out of 5',
    clientReviews: 14,
    clientSpent: '$42K total spent',
    clientHires: 11,
    clientHireRate: '82% hire rate',
  },
  '~033000000000000000004': {
    id: '~033000000000000000004',
    slug: 'Postgres-17-Migration-Specialist',
    title: 'Postgres 17 Migration Specialist',
    posted: 'Posted 18 minutes ago',
    descriptionHtml: 'Summary Upgrade production databases to Postgres 17 using Atlas.',
    bidType: 'fixed',
    fixedAmount: '$1,500.00',
    experienceLevel: 'Expert',
    duration: 'Less than 1 month',
    connectsRequired: 8,
    skills: ['PostgreSQL', 'Docker'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.85 out of 5',
    clientReviews: 19,
    clientSpent: '$55K total spent',
    clientHires: 15,
    clientHireRate: '84% hire rate',
  },
  '~033000000000000000005': {
    id: '~033000000000000000005',
    slug: 'Saved-MCP-Tooling-Architect',
    title: 'Saved MCP Tooling Architect',
    posted: 'Posted 1 day ago',
    descriptionHtml: 'Summary Build typed MCP servers in Go with Streamable HTTP and stdio.',
    bidType: 'fixed',
    fixedAmount: '$2,100.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    connectsRequired: 10,
    skills: ['Go', 'MCP', 'TypeScript'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: '5 to 10',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.95 out of 5',
    clientReviews: 22,
    clientSpent: '$65K total spent',
    clientHires: 19,
    clientHireRate: '88% hire rate',
  },
  '~033000000000000000006': {
    id: '~033000000000000000006',
    slug: 'Saved-Shadow-DOM-UI-Engineer',
    title: 'Saved Shadow DOM UI Engineer',
    posted: 'Posted 2 days ago',
    descriptionHtml: 'Summary Craft isolated Shadow DOM toolbars and Side Panel React/TS UIs.',
    bidType: 'fixed',
    fixedAmount: '$1,600.00',
    experienceLevel: 'Intermediate',
    duration: '1 to 3 months',
    connectsRequired: 8,
    skills: ['TypeScript', 'CSS'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: '5 to 10',
    paymentVerified: true,
    clientCountry: 'United Kingdom',
    clientRating: '4.8 out of 5',
    clientReviews: 13,
    clientSpent: '$29K total spent',
    clientHires: 9,
    clientHireRate: '78% hire rate',
  },
  '~040100000000000000002': {
    id: '~040100000000000000002',
    slug: 'Go-PostgreSQL-Automation-Platform',
    title: 'Go & PostgreSQL Automation Platform',
    posted: 'Posted 30 minutes ago',
    descriptionHtml:
      'Summary Looking for a senior Go and PostgreSQL engineer to build a reliable workflow engine with TypeScript extension hooks.',
    bidType: 'fixed',
    fixedAmount: '$2,200.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 10,
    skills: ['Go', 'PostgreSQL', 'TypeScript'],
    attachments: ['workflow-spec.pdf'],
    screeningQuestions: [
      { prompt: 'Explain your Go transaction isolation pattern.', required: true },
      { prompt: 'Share a TypeScript Playwright integration you built.', required: true },
    ],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    lastViewed: '15 minutes ago',
    interviewing: 1,
    invitesSent: 2,
    unansweredInvites: 0,
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.95 out of 5',
    clientReviews: 40,
    clientSpent: '$110K total spent',
    clientHires: 32,
    clientHireRate: '88% hire rate',
  },
  '~040200000000000000001': {
    id: '~040200000000000000001',
    slug: 'React-Dashboard-Modernization-P1',
    title: 'React Dashboard Modernization',
    posted: 'Posted 1 hour ago',
    descriptionHtml: 'Summary Upgrade a React analytics dashboard with strict TypeScript.',
    bidType: 'fixed',
    fixedAmount: '$1,500.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    connectsRequired: 8,
    skills: ['React', 'TypeScript'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 18,
    clientSpent: '$34K total spent',
    clientHires: 12,
    clientHireRate: '84% hire rate',
  },
  '~040200000000000000002': {
    id: '~040200000000000000002',
    slug: 'React-Component-Library-P1',
    title: 'React Accessible Component Library',
    posted: 'Posted 2 hours ago',
    descriptionHtml: 'Summary Build accessible React UI primitives.',
    bidType: 'fixed',
    fixedAmount: '$1,900.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    connectsRequired: 10,
    skills: ['React', 'Accessibility'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: '5 to 10',
    paymentVerified: true,
    clientCountry: 'Canada',
    clientRating: '4.85 out of 5',
    clientReviews: 12,
    clientSpent: '$24K total spent',
    clientHires: 9,
    clientHireRate: '80% hire rate',
  },
  '~040200000000000000003': {
    id: '~040200000000000000003',
    slug: 'React-State-Refactor-P2',
    title: 'React State Management Refactor',
    posted: 'Posted 3 hours ago',
    descriptionHtml: 'Summary Simplify React client state and query caching.',
    bidType: 'fixed',
    fixedAmount: '$1,600.00',
    experienceLevel: 'Intermediate',
    duration: '1 to 3 months',
    connectsRequired: 8,
    skills: ['React', 'TypeScript'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 15,
    clientSpent: '$29K total spent',
    clientHires: 11,
    clientHireRate: '82% hire rate',
  },
  '~040200000000000000004': {
    id: '~040200000000000000004',
    slug: 'React-Performance-Audit-P2',
    title: 'React Rendering Performance Audit',
    posted: 'Posted 4 hours ago',
    descriptionHtml: 'Summary Profile and eliminate unnecessary React re-renders.',
    bidType: 'fixed',
    fixedAmount: '$1,100.00',
    experienceLevel: 'Expert',
    duration: 'Less than 1 month',
    connectsRequired: 8,
    skills: ['React', 'Performance'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: '5 to 10',
    paymentVerified: true,
    clientCountry: 'United Kingdom',
    clientRating: '4.8 out of 5',
    clientReviews: 10,
    clientSpent: '$20K total spent',
    clientHires: 7,
    clientHireRate: '77% hire rate',
  },
  '~040600000000000000001': {
    id: '~040600000000000000001',
    slug: 'TypeScript-SDK-Architecture',
    title: 'TypeScript SDK Architecture & Testing',
    posted: 'Posted 1 hour ago',
    descriptionHtml: 'Summary Design a strict TypeScript SDK with Biome and Vitest.',
    bidType: 'fixed',
    fixedAmount: '$2,000.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    connectsRequired: 10,
    skills: ['TypeScript', 'Vitest'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 21,
    clientSpent: '$50K total spent',
    clientHires: 16,
    clientHireRate: '86% hire rate',
  },
  '~040600000000000000002': {
    id: '~040600000000000000002',
    slug: 'TypeScript-Playwright-Harness',
    title: 'TypeScript Playwright Test Harness',
    posted: 'Posted 2 hours ago',
    descriptionHtml: 'Summary Implement isolated TypeScript Playwright harnesses.',
    bidType: 'fixed',
    fixedAmount: '$1,700.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    connectsRequired: 8,
    skills: ['TypeScript', 'Playwright'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: '5 to 10',
    paymentVerified: true,
    clientCountry: 'Canada',
    clientRating: '4.85 out of 5',
    clientReviews: 13,
    clientSpent: '$31K total spent',
    clientHires: 10,
    clientHireRate: '81% hire rate',
  },
  '~01abc': {
    id: '~01abc',
    slug: 'Screening-Proposal-E2E-Job',
    title: 'Full-Stack Screening Proposal Job',
    posted: 'Posted 1 hour ago',
    descriptionHtml:
      'Summary Implement end-to-end typed backend endpoints and screening workflow validation.',
    bidType: 'fixed',
    fixedAmount: '$1,800.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 8,
    skills: ['Go', 'TypeScript', 'PostgreSQL'],
    attachments: ['requirements.pdf'],
    screeningQuestions: [
      { prompt: 'Describe your Go API testing experience.', required: true },
      { prompt: 'How do you handle database migrations?', required: true },
    ],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    lastViewed: '25 minutes ago',
    interviewing: 1,
    invitesSent: 2,
    unansweredInvites: 0,
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.95 out of 5',
    clientReviews: 26,
    clientSpent: '$75K total spent',
    clientHires: 20,
    clientHireRate: '87% hire rate',
  },
  '~02xyz': {
    id: '~02xyz',
    slug: 'Concurrent-Mutex-Enrichment-Job',
    title: 'Concurrent Mutex Enrichment Job',
    posted: 'Posted 2 hours ago',
    descriptionHtml: 'Summary Build serialized browser tab automation and PostgreSQL persistence.',
    bidType: 'fixed',
    fixedAmount: '$2,200.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 10,
    skills: ['Go', 'Playwright', 'PostgreSQL'],
    attachments: [],
    screeningQuestions: [],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 18,
    clientSpent: '$52K total spent',
    clientHires: 14,
    clientHireRate: '85% hire rate',
  },
  '~01linked': {
    id: '~01linked',
    slug: 'Linked-Message-Thread-Job',
    title: 'Linked Message Thread Integration Job',
    posted: 'Posted 1 day ago',
    descriptionHtml: 'Summary Ongoing integration project linked to room_777.',
    bidType: 'fixed',
    fixedAmount: '$1,600.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 8,
    skills: ['Go', 'TypeScript'],
    attachments: [],
    screeningQuestions: [],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 15,
    clientSpent: '$40K total spent',
    clientHires: 12,
    clientHireRate: '83% hire rate',
  },
  '~05dual': {
    id: '~05dual',
    slug: 'Dual-Transport-MCP-Job',
    title: 'Dual Transport MCP Verification Job',
    posted: 'Posted 1 hour ago',
    descriptionHtml:
      'Summary Verify Streamable HTTP and stdio MCP interoperability with live proposal filling.',
    bidType: 'fixed',
    fixedAmount: '$1,500.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 10,
    skills: ['Go', 'MCP', 'TypeScript'],
    attachments: [],
    screeningQuestions: [
      { prompt: 'Confirm availability for synchronous kickoff.', required: true },
    ],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.95 out of 5',
    clientReviews: 22,
    clientSpent: '$68K total spent',
    clientHires: 17,
    clientHireRate: '88% hire rate',
  },
  '~06rust': {
    id: '~06rust',
    slug: 'Rust-PostgreSQL-Go-Systems-Job',
    title: 'Rust, PostgreSQL & Go Systems Engineer',
    posted: 'Posted 1 hour ago',
    descriptionHtml:
      'Summary High-performance backend system combining Rust workers, Go APIs, and PostgreSQL storage for real-time telemetry.',
    bidType: 'fixed',
    fixedAmount: '$3,000.00',
    experienceLevel: 'Expert',
    duration: '3 to 6 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 12,
    skills: ['Rust', 'PostgreSQL', 'Go'],
    attachments: [],
    screeningQuestions: [],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.95 out of 5',
    clientReviews: 28,
    clientSpent: '$90K total spent',
    clientHires: 24,
    clientHireRate: '91% hire rate',
  },
  '~07won': {
    id: '~07won',
    slug: 'Won-Offer-Laravel-Go-Platform',
    title: 'Won Offer: Go & TypeScript Delivery Platform',
    posted: 'Posted 3 days ago',
    descriptionHtml:
      'Summary Contract offer accepted for Go + TypeScript automation platform delivery.',
    bidType: 'fixed',
    fixedAmount: '$4,000.00',
    experienceLevel: 'Expert',
    duration: '3 to 6 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 12,
    skills: ['Go', 'TypeScript', 'PostgreSQL'],
    attachments: [],
    screeningQuestions: [],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '5.0 out of 5',
    clientReviews: 31,
    clientSpent: '$140K total spent',
    clientHires: 29,
    clientHireRate: '92% hire rate',
  },
  '~09msg': {
    id: '~09msg',
    slug: 'Client-Reply-Triage-Go-Job',
    title: 'Client Reply Triage Go Architecture Job',
    posted: 'Posted 1 day ago',
    descriptionHtml: 'Summary Go and PostgreSQL architecture engagement linked to room_901.',
    bidType: 'fixed',
    fixedAmount: '$2,000.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 10,
    skills: ['Go', 'PostgreSQL'],
    attachments: [],
    screeningQuestions: [],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 19,
    clientSpent: '$62K total spent',
    clientHires: 15,
    clientHireRate: '86% hire rate',
  },
  '~022115332344639404': {
    id: '~022115332344639404',
    slug: 'unavailable',
    title: 'This job is no longer available',
    posted: '',
    descriptionHtml: '',
    bidType: 'fixed',
    experienceLevel: '',
    duration: '',
    skills: [],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    paymentVerified: false,
    clientCountry: '',
    errorVariant: 'not_found',
  },
  '~000000000000000404': {
    id: '~000000000000000404',
    slug: 'unavailable',
    title: 'This job is no longer available',
    posted: '',
    descriptionHtml: '',
    bidType: 'fixed',
    experienceLevel: '',
    duration: '',
    skills: [],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    paymentVerified: false,
    clientCountry: '',
    errorVariant: 'not_found',
  },
  '~000000000000000403': {
    id: '~000000000000000403',
    slug: 'private',
    title: 'This job is private',
    posted: '',
    descriptionHtml: '',
    bidType: 'fixed',
    experienceLevel: '',
    duration: '',
    skills: [],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    paymentVerified: false,
    clientCountry: '',
    errorVariant: 'private',
  },
  '~022115332344639405': {
    id: '~022115332344639405',
    slug: 'shell',
    title: 'Find the best freelance jobs',
    posted: '',
    descriptionHtml: '',
    bidType: 'fixed',
    experienceLevel: '',
    duration: '',
    skills: [],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    paymentVerified: false,
    clientCountry: '',
    errorVariant: 'soft_404',
  },
  '~000000000000000000': {
    id: '~000000000000000000',
    slug: 'shell',
    title: 'Find the best freelance jobs',
    posted: '',
    descriptionHtml: '',
    bidType: 'fixed',
    experienceLevel: '',
    duration: '',
    skills: [],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    paymentVerified: false,
    clientCountry: '',
    errorVariant: 'soft_404',
  },
  '~055500000000000000002': {
    id: '~055500000000000000002',
    slug: 'Senior-Auth-Engineer-Two-Step-Verification-Security-Check',
    title: 'Senior Auth Engineer — Two-Step Verification & Security Check',
    posted: 'Posted 1 hour ago',
    descriptionHtml:
      'Summary Build Two-Step Verification flows and automated security check monitoring for unusual activity.',
    bidType: 'fixed',
    fixedAmount: '$1,800.00',
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 10,
    skills: ['Go', 'TypeScript', 'Security'],
    attachments: [],
    screeningQuestions: [],
    qualifications: DEFAULT_QUALIFICATIONS,
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 20,
    clientSpent: '$50K total spent',
    clientHires: 15,
    clientHireRate: '85% hire rate',
  },
};

// Dynamically generate Python page 1..5 jobs (~040400000000000000001..010)
for (let i = 1; i <= 10; i += 1) {
  const padded = String(i).padStart(2, '0');
  const id = `~0404000000000000000${padded}`;
  JOB_DETAIL_REGISTRY[id] = {
    id,
    slug: `Python-Backend-Worker-${i}`,
    title: `Python Automation Engineer #${i}`,
    posted: `Posted ${i} hours ago`,
    descriptionHtml: `Summary Python data pipeline and FastAPI automation project #${i}.`,
    bidType: 'fixed',
    fixedAmount: `$${1000 + i * 100}.00`,
    experienceLevel: 'Expert',
    duration: '1 to 3 months',
    hoursPerWeek: '30+ hrs/week',
    connectsRequired: 8,
    skills: ['Python', 'PostgreSQL', 'Docker'],
    attachments: [],
    screeningQuestions: [],
    qualifications: [],
    proposalsTier: 'Less than 5',
    paymentVerified: true,
    clientCountry: 'United States',
    clientRating: '4.9 out of 5',
    clientReviews: 12 + i,
    clientSpent: '$40K total spent',
    clientHires: 10 + i,
    clientHireRate: '85% hire rate',
  };
}

export function extractJobIdFromPath(pathname: string): string | null {
  const match = /~([0-9a-zA-Z]+)/.exec(pathname);
  return match ? `~${match[1]}` : null;
}

export function getJobDetailSpec(jobId: string): JobDetailSpec | undefined {
  const normalized = jobId.startsWith('~') ? jobId : `~${jobId}`;
  return JOB_DETAIL_REGISTRY[normalized];
}

export interface DetailRenderOptions {
  driftMode: DriftMode;
  omitDomClientMetrics?: boolean;
  proposalsOverride?: string;
  asDrawer?: boolean;
}

function renderSkillsSection(skills: string[], driftMode: DriftMode): string {
  if (skills.length === 0) {
    return '';
  }
  const items = skills
    .map((skill) => `      <div class="air3-line-clamp">${escapeHtml(skill)}</div>`)
    .join('\n');

  if (driftMode === 'clean_no_fragile') {
    return `    <section>
      <div class="skills-list">
${items}
      </div>
    </section>`;
  }
  if (driftMode === 'broken_vue_hash') {
    return `    <section data-v-9f8e7d6c>
      <div class="skills-list">
${items}
      </div>
    </section>`;
  }
  return `    <section data-v-3b2c2248>
      <div class="skills-list">
${items}
      </div>
    </section>`;
}

export function renderJobDetailsContentInner(
  job: JobDetailSpec,
  opts: DetailRenderOptions,
): string {
  const headingTag = opts.asDrawer ? 'h4' : 'h1';
  const headingHtml =
    opts.driftMode === 'broken_detail'
      ? `<h2 data-test="detail-title">${escapeHtml(job.title)}</h2>`
      : opts.asDrawer
        ? `<div class="air3-card-section"><${headingTag}>${escapeHtml(job.title)}</${headingTag}></div>`
        : `<h1>${escapeHtml(job.title)}</h1>`;

  const descriptionSection =
    opts.driftMode === 'broken_detail'
      ? `<section data-test="BrokenDescription"><div class="broken-text">${job.descriptionHtml}</div></section>`
      : `<section data-test="Description">
      <p class="multiline-text">${job.descriptionHtml}</p>
    </section>`;

  const featureItems: string[] = [];
  if (!job.omitBudget) {
    if (job.bidType === 'hourly') {
      const ratePart = job.hourlyMax
        ? `<strong>${escapeHtml(job.hourlyMin ?? '$80.00')}</strong> - <strong>${escapeHtml(job.hourlyMax)}</strong>`
        : `<strong>${escapeHtml(job.hourlyMin ?? '$85.00')}</strong>`;
      featureItems.push(`      <li><div data-cy="clock-timelog"></div><div>${ratePart}</div></li>`);
    } else if (job.fixedAmount) {
      featureItems.push(
        `      <li><div data-cy="fixed-price"></div><strong>${escapeHtml(job.fixedAmount)}</strong></li>`,
      );
    }
  }
  if (job.experienceLevel) {
    featureItems.push(
      `      <li><div data-cy="expertise"></div><strong>${escapeHtml(job.experienceLevel)}</strong></li>`,
    );
  }
  if (job.duration) {
    featureItems.push(
      `      <li><div data-cy="duration2"></div><strong>${escapeHtml(job.duration)}</strong></li>`,
    );
  }
  if (job.hoursPerWeek) {
    featureItems.push(
      `      <li><div data-cy="clock-hourly"></div><strong>${escapeHtml(job.hoursPerWeek)}</strong></li>`,
    );
  }

  const connectsHtml =
    !opts.omitDomClientMetrics && job.connectsRequired !== undefined
      ? `    <div data-test="connects-required">Send a proposal for: <strong>${job.connectsRequired} Connects</strong></div>`
      : '';

  const attachmentsHtml =
    job.attachments.length > 0
      ? `    <section data-test="attachments">
      <h3>Attachments</h3>
      <ul>
${job.attachments
  .map(
    (att) =>
      `        <li><a href="/att/${encodeURIComponent(att)}" data-test="attachment-link">${escapeHtml(att)}</a></li>`,
  )
  .join('\n')}
      </ul>
    </section>`
      : '';

  const screeningHtml =
    job.screeningQuestions.length > 0
      ? `    <section data-test="screening-questions">
      <h3>You will be asked to answer the following questions when submitting a proposal:</h3>
      <ol>
${job.screeningQuestions
  .map(
    (q) =>
      `        <li data-test="screening-question" data-required="${q.required ? 'true' : 'false'}">${escapeHtml(q.prompt)}${q.required ? ' <span class="required">*</span>' : ''}</li>`,
  )
  .join('\n')}
      </ol>
    </section>`
      : '';

  const qualificationsHtml =
    job.qualifications.length > 0
      ? `    <section data-test="qualifications">
      <h3>Preferred qualifications</h3>
      <ul class="qualifications-list">
${job.qualifications
  .map(
    (qual) =>
      `        <li data-test="qualification-item">${escapeHtml(qual.label)}: <strong>${escapeHtml(qual.value)}</strong></li>`,
  )
  .join('\n')}
      </ul>
    </section>`
      : '';

  const effectiveProposals = opts.proposalsOverride ?? job.proposalsTier;
  const activityItems: string[] = [];
  if (effectiveProposals) {
    activityItems.push(`        <li class="ca-item">
          <span class="title">Proposals:</span>
          <span class="help-icon"><span data-test="popper">Close the tooltipThis range includes relevant proposals</span></span>
          <span class="value">${escapeHtml(effectiveProposals)}</span>
        </li>`);
  }
  if (job.lastViewed) {
    activityItems.push(
      `        <li class="ca-item"><span class="title">Last viewed by client:</span><span class="value">${escapeHtml(job.lastViewed)}</span></li>`,
    );
  }
  if (job.interviewing !== undefined) {
    activityItems.push(
      `        <li class="ca-item"><span class="title">Interviewing:</span><span class="value">${job.interviewing}</span></li>`,
    );
  }
  if (job.invitesSent !== undefined) {
    activityItems.push(
      `        <li class="ca-item"><span class="title">Invites sent:</span><span class="value">${job.invitesSent}</span></li>`,
    );
  }
  if (job.unansweredInvites !== undefined) {
    activityItems.push(
      `        <li class="ca-item"><span class="title">Unanswered invites:</span><span class="value">${job.unansweredInvites}</span></li>`,
    );
  }

  const clientActivityHtml =
    activityItems.length > 0
      ? `    <section data-test="client-activity">
      <h3>Activity on this job</h3>
      <ul class="visitor client-activity-items list-unstyled">
${activityItems.join('\n')}
      </ul>
    </section>`
      : '';

  const clientItems: string[] = [];
  if (job.paymentVerified) {
    clientItems.push(
      '        <li data-qa="payment-verified" data-test="payment-verified">Payment method verified</li>',
    );
  }
  if (job.clientCountry) {
    clientItems.push(`        <li data-qa="client-location">${escapeHtml(job.clientCountry)}</li>`);
  }
  if (job.clientRating) {
    clientItems.push(`        <li data-qa="client-rating">
          <div class="air3-rating-background">${escapeHtml(job.clientRating)}</div>
          ${job.clientReviews !== undefined ? `<span data-qa="client-reviews" data-test="client-reviews">${job.clientReviews} reviews</span>` : ''}
        </li>`);
  }
  if (job.clientSpent) {
    clientItems.push(
      `        <li data-qa="client-spend"><strong>${escapeHtml(job.clientSpent)}</strong></li>`,
    );
  }
  if (job.clientHires !== undefined) {
    clientItems.push(`        <li data-qa="client-hires">${job.clientHires} hires</li>`);
  }
  if (!opts.omitDomClientMetrics && job.clientHireRate) {
    clientItems.push(
      `        <li data-qa="client-hire-rate" data-test="client-hire-rate">${escapeHtml(job.clientHireRate)}</li>`,
    );
  }
  if (job.clientAvgHourly) {
    clientItems.push(
      `        <li data-qa="client-avg-hourly">${escapeHtml(job.clientAvgHourly)}</li>`,
    );
  }

  const aboutClientHtml =
    clientItems.length > 0
      ? `    <aside data-test="about-client">
      <h3>About the client</h3>
      <ul>
${clientItems.join('\n')}
      </ul>
    </aside>`
      : '';

  const extraHooks = opts.driftMode === 'unmapped_auth' ? renderUnmappedAuthHooks() : '';

  return `<div class="job-details-content"${opts.asDrawer ? ' data-test="job-details-drawer"' : ''} data-job-id="${escapeHtml(job.id)}">
    ${headingHtml}
    ${job.posted ? `<div class="posted-on-line"><span>${escapeHtml(job.posted)}</span></div>` : ''}
    ${descriptionSection}
    <ul class="job-features">
${featureItems.join('\n')}
    </ul>
${connectsHtml}
${renderSkillsSection(job.skills, opts.driftMode)}
${attachmentsHtml}
${screeningHtml}
${qualificationsHtml}
${clientActivityHtml}
${aboutClientHtml}
${extraHooks}
    <a data-test="apply-now-btn" href="/nx/proposals/job/${escapeHtml(job.id)}/apply/">Apply now</a>
  </div>`;
}

export function renderJobDetailPage(
  jobId: string,
  url: URL,
  authState: AuthState,
  opts: DetailRenderOptions,
): { status: number; html: string } {
  const job = getJobDetailSpec(jobId);
  if (!job) {
    return {
      status: 404,
      html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Job Not Found - Upwork</title></head>
<body><main><h1>This job is no longer available</h1></main></body>
</html>`,
    };
  }

  const variantParam = url.searchParams.get('variant');
  const statusParam = url.searchParams.get('status');
  const proposalsParam = url.searchParams.get('proposals');

  if (job.errorVariant === 'not_found' || variantParam === 'private') {
    const isPrivate = variantParam === 'private';
    const status = statusParam === '404' ? 404 : 200;
    const heading = isPrivate
      ? '<h1 data-test="error-title">This job is private</h1>'
      : '<h1>This job is no longer available</h1>';
    return {
      status,
      html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>${isPrivate ? 'Private Job' : 'Job Not Found'} - Upwork</title></head>
<body>${renderSharedAuthenticatedNav(authState)}<main>${heading}</main></body>
</html>`,
    };
  }

  if (job.errorVariant === 'private') {
    return {
      status: 200,
      html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Private Job - Upwork</title></head>
<body>${renderSharedAuthenticatedNav(authState)}<main><h1 data-test="error-title">This job is private</h1></main></body>
</html>`,
    };
  }

  if (job.errorVariant === 'soft_404') {
    return {
      status: 200,
      html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Upwork</title></head>
<body>${renderSharedAuthenticatedNav(authState)}<main><h1>Find the best freelance jobs</h1></main></body>
</html>`,
    };
  }

  const proposalsOverride = proposalsParam === 'high' ? '20 to 50' : opts.proposalsOverride;

  const inner = renderJobDetailsContentInner(job, {
    ...opts,
    proposalsOverride,
    asDrawer: false,
  });

  return {
    status: 200,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Job Details - ${escapeHtml(job.title)} | Upwork</title></head>
<body>
${renderSharedAuthenticatedNav(authState)}
<main>
  ${inner}
</main>
</body>
</html>`,
  };
}
