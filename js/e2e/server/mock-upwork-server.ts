import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  renderCaptchaChallengeHtml,
  renderCloudflareChallengeHtml,
  renderLoginWallHtml,
  renderRateLimitHtml,
  renderTwoFactorHtml,
} from '../fixtures/challenge-fixtures.ts';
import { extractJobIdFromPath, renderJobDetailPage } from '../fixtures/detail-fixtures.ts';
import { resolveEffectiveDriftMode } from '../fixtures/drift-fixtures.ts';
import {
  createInitialRoomsState,
  renderMessagesRoomsPage,
  renderMessageThreadPage,
  resolveRoomById,
} from '../fixtures/messages-fixtures.ts';
import {
  renderProposalApplyPage,
  renderProposalConfirmationPage,
  renderProposalsDashboardPage,
} from '../fixtures/proposal-fixtures.ts';
import {
  buildGraphqlSearchResponse,
  renderFindWorkFeedPage,
  renderSearchJobsPage,
} from '../fixtures/search-fixtures.ts';
import type {
  MockMessageEntry,
  MockRoomState,
  MockServerConfig,
  MockServerHandle,
  MockServerStateSnapshot,
  RecordedRequest,
  SubmittedProposalRecord,
} from './mock-types.ts';

export type * from './mock-types.ts';

function createDefaultConfig(): MockServerConfig {
  return {
    authState: 'authenticated',
    challenge: 'none',
    challengeOnPath: undefined,
    driftMode: 'healthy',
    passiveTapEnabled: false,
    omitDomClientMetrics: false,
    lockApplyBid: false,
    rateLimitRemaining: 0,
    delayMs: 0,
    delayMsByPath: {},
    totalSearchPages: 2,
    unreadMessages: [],
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(html)),
  });
  res.end(html);
}

function sendRedirect(res: http.ServerResponse, location: string): void {
  res.writeHead(302, {
    location,
    'content-length': '0',
  });
  res.end();
}

function matchesPattern(pattern: string, target: string): boolean {
  try {
    const regex = new RegExp(pattern);
    return regex.test(target);
  } catch {
    return target.includes(pattern);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function startMockUpworkServer(port = 0): Promise<MockServerHandle> {
  let config: MockServerConfig = createDefaultConfig();
  let recordedRequests: RecordedRequest[] = [];
  let submittedProposals: SubmittedProposalRecord[] = [];
  let rooms: Record<string, MockRoomState> = createInitialRoomsState();
  let proposalSeq = 1;
  let messageSeq = 1;

  const resetAll = (): void => {
    config = createDefaultConfig();
    recordedRequests = [];
    submittedProposals = [];
    rooms = createInitialRoomsState();
    proposalSeq = 1;
    messageSeq = 1;
  };

  const applyConfigPatch = (patch: Partial<MockServerConfig>): MockServerConfig => {
    config = {
      ...config,
      ...patch,
      delayMsByPath: patch.delayMsByPath ? { ...patch.delayMsByPath } : config.delayMsByPath,
      unreadMessages: patch.unreadMessages ?? config.unreadMessages,
    };
    if (patch.challengeOnPath === null || patch.challengeOnPath === '') {
      config.challengeOnPath = undefined;
    }

    if (Array.isArray(patch.unreadMessages)) {
      for (const item of patch.unreadMessages) {
        let room = resolveRoomById(rooms, item.roomId);
        if (!room) {
          room = {
            roomId: item.roomId,
            aliases: [],
            clientName: item.sender,
            clientCompany: 'Mock Client Co',
            jobId: '~022115332344639171',
            jobTitle: 'Injected Conversation Job',
            unreadCount: 0,
            messages: [],
          };
          rooms[item.roomId] = room;
        }
        const entry: MockMessageEntry = {
          id: `msg_injected_${messageSeq}`,
          sender: item.sender,
          body: item.body,
          timestamp: item.timestamp ?? new Date().toISOString(),
        };
        messageSeq += 1;
        room.messages.push(entry);
        room.unreadCount += 1;
      }
    }

    return config;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? 'GET';
      const rawUrl = req.url ?? '/';
      const parsed = new URL(rawUrl, 'http://127.0.0.1');
      const pathname = parsed.pathname;
      const search = parsed.search;
      const body = await readBody(req);

      // Control plane routes (/__mock/*)
      if (pathname === '/__mock/health' && method === 'GET') {
        const addr = server.address() as AddressInfo | null;
        sendJson(res, 200, { ok: true, port: addr?.port ?? port });
        return;
      }

      if (pathname === '/__mock/reset' && method === 'POST') {
        resetAll();
        sendJson(res, 200, { reset: true });
        return;
      }

      if ((pathname === '/__mock/config' || pathname === '/__mock/scenario') && method === 'POST') {
        const patch = (body ? JSON.parse(body) : {}) as Partial<MockServerConfig>;
        const updated = applyConfigPatch(patch);
        sendJson(res, 200, updated);
        return;
      }

      if (pathname === '/__mock/requests' && method === 'GET') {
        const pathPrefix = parsed.searchParams.get('pathPrefix');
        const filtered = pathPrefix
          ? recordedRequests.filter((r) => r.pathname.startsWith(pathPrefix))
          : recordedRequests;
        sendJson(res, 200, { requests: filtered });
        return;
      }

      if (pathname === '/__mock/state' && method === 'GET') {
        const snapshot: MockServerStateSnapshot = {
          config,
          submittedProposals,
          rooms,
        };
        sendJson(res, 200, snapshot);
        return;
      }

      // Non-Upwork test page
      if (pathname === '/non-upwork') {
        sendHtml(
          res,
          200,
          `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><title>Non-Upwork Page</title></head><body><main><h1>External Page</h1><p>Not Upwork</p></main></body></html>`,
        );
        return;
      }

      if (pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Record all Upwork/mock-upwork requests
      const normalizedHeaders: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') {
          normalizedHeaders[key] = value;
        } else if (Array.isArray(value)) {
          normalizedHeaders[key] = value.join(', ');
        }
      }
      const now = Date.now();
      const queryObj = Object.fromEntries(parsed.searchParams.entries());
      const isPageNav =
        method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/att/');

      recordedRequests.push({
        method,
        path: pathname,
        pathname,
        search,
        query: queryObj,
        headers: normalizedHeaders,
        body,
        timestamp: now,
        timestampMs: now,
        isPageNavigation: isPageNav,
      });

      // Simulated delays
      const fullTarget = `${pathname}${search}`;
      let totalDelay = config.delayMs;
      for (const [pattern, ms] of Object.entries(config.delayMsByPath)) {
        if (ms > 0 && matchesPattern(pattern, fullTarget)) {
          totalDelay += ms;
        }
      }
      if (totalDelay > 0) {
        await sleep(totalDelay);
      }

      // Simulated 429 rate limiting
      if (config.rateLimitRemaining > 0) {
        config.rateLimitRemaining -= 1;
        const rlHtml = renderRateLimitHtml();
        res.writeHead(429, {
          'content-type': 'text/html; charset=utf-8',
          'retry-after': '1',
          'content-length': String(Buffer.byteLength(rlHtml)),
        });
        res.end(rlHtml);
        return;
      }

      // Direct challenge routes always render their challenge fixture
      if (pathname === '/ab/account-security/login') {
        sendHtml(res, 200, renderLoginWallHtml());
        return;
      }
      if (pathname === '/ab/account-security/two-factor') {
        sendHtml(res, 200, renderTwoFactorHtml());
        return;
      }
      if (pathname === '/cdn-cgi/challenge-platform' || pathname === '/nx/challenge/verify') {
        sendHtml(res, 200, renderCaptchaChallengeHtml());
        return;
      }

      // Configured challenge injection
      const isMockMessageSendPost =
        method === 'POST' && /^\/api\/mock\/messages\/[^/]+\/send$/.test(pathname);
      if (
        !isMockMessageSendPost &&
        config.challenge !== 'none' &&
        (!config.challengeOnPath || matchesPattern(config.challengeOnPath, fullTarget))
      ) {
        if (config.challenge === 'login') {
          sendRedirect(res, '/ab/account-security/login');
          return;
        }
        if (config.challenge === 'two_factor') {
          sendHtml(res, 200, renderTwoFactorHtml());
          return;
        }
        if (config.challenge === 'captcha') {
          sendHtml(res, 200, renderCaptchaChallengeHtml());
          return;
        }
        if (config.challenge === 'cloudflare') {
          sendHtml(res, 403, renderCloudflareChallengeHtml());
          return;
        }
      }

      // Search ?q=login_wall
      if (
        (pathname === '/nx/search/jobs/' || pathname === '/nx/search/jobs') &&
        parsed.searchParams.get('q') === 'login_wall'
      ) {
        sendRedirect(res, '/ab/account-security/login');
        return;
      }

      // Auth guard on authenticated-only routes
      const isAuthRequiredRoute =
        pathname.startsWith('/nx/find-work/') ||
        pathname.startsWith('/nx/proposals/') ||
        pathname === '/nx/proposals' ||
        pathname.startsWith('/ab/messages/');

      if (config.authState === 'logged_out' && isAuthRequiredRoute) {
        sendRedirect(res, '/ab/account-security/login');
        return;
      }

      // Search listings
      if (pathname === '/nx/search/jobs/' || pathname === '/nx/search/jobs') {
        sendHtml(res, 200, renderSearchJobsPage(parsed, config));
        return;
      }

      // Authenticated feeds
      if (pathname === '/nx/find-work/best-matches') {
        sendHtml(res, 200, renderFindWorkFeedPage('best-matches', config));
        return;
      }
      if (pathname === '/nx/find-work/most-recent') {
        sendHtml(res, 200, renderFindWorkFeedPage('most-recent', config));
        return;
      }
      if (pathname === '/nx/find-work/saved-jobs') {
        sendHtml(res, 200, renderFindWorkFeedPage('saved-jobs', config));
        return;
      }

      // GraphQL passive tap endpoint
      if (pathname.startsWith('/api/graphql') && method === 'POST') {
        let query = parsed.searchParams.get('q') ?? '';
        try {
          const parsedBody = JSON.parse(body) as { variables?: { query?: string } };
          if (parsedBody.variables?.query) {
            query = parsedBody.variables.query;
          }
        } catch {
          // ignore non-JSON body
        }
        sendJson(res, 200, buildGraphqlSearchResponse(query));
        return;
      }

      // Job detail routes (/jobs/*_~<id>/ or /jobs/~<id>/)
      if (pathname.startsWith('/jobs/')) {
        const jobId = extractJobIdFromPath(pathname);
        if (!jobId) {
          sendHtml(res, 404, '<h1>Job not found</h1>');
          return;
        }
        const effectiveDrift = resolveEffectiveDriftMode(parsed, config);
        const result = renderJobDetailPage(jobId, parsed, config.authState, {
          driftMode: effectiveDrift,
          omitDomClientMetrics: config.omitDomClientMetrics,
        });
        sendHtml(res, result.status, result.html);
        return;
      }

      // Proposal apply page (/nx/proposals/job/:id/apply/)
      const applyMatch = /^\/nx\/proposals\/job\/([^/]+)\/apply\/?$/.exec(pathname);
      if (applyMatch && method === 'GET') {
        const jobId = applyMatch[1];
        const result = renderProposalApplyPage(
          jobId,
          parsed,
          config.authState,
          config.lockApplyBid,
        );
        sendHtml(res, result.status, result.html);
        return;
      }

      // Proposal submit endpoint
      if (pathname === '/api/mock/proposals/submit' && method === 'POST') {
        const payload = (body ? JSON.parse(body) : {}) as {
          jobId?: string;
          bidType?: 'hourly' | 'fixed';
          bidAmount?: string;
          milestones?: Array<{ description: string; dueDate: string; amount: string }>;
          coverLetter?: string;
          screeningAnswers?: string[];
          boostConnects?: number;
        };
        const jobId = payload.jobId ?? '~022115332344639171';
        const proposalId = `~mockprop${proposalSeq}`;
        proposalSeq += 1;

        const record: SubmittedProposalRecord = {
          proposalId,
          jobId,
          bidType: payload.bidType ?? 'fixed',
          bidAmount: payload.bidAmount ?? '0',
          milestones: payload.milestones ?? [],
          coverLetter: payload.coverLetter ?? '',
          screeningAnswers: payload.screeningAnswers ?? [],
          boostConnects: payload.boostConnects ?? 0,
          submittedAt: new Date().toISOString(),
        };
        submittedProposals.push(record);
        sendJson(res, 200, {
          ok: true,
          proposalId,
          redirectUrl: `/nx/proposals/confirmation/${jobId}`,
        });
        return;
      }

      // Proposal confirmation routes
      const confirmMatch = /^\/nx\/proposals\/confirmation\/([^/]+)\/?$/.exec(pathname);
      if (confirmMatch && method === 'GET') {
        sendHtml(res, 200, renderProposalConfirmationPage(config.authState, confirmMatch[1]));
        return;
      }
      if (pathname === '/nx/proposals/submitted' && method === 'GET') {
        const jobParam = parsed.searchParams.get('job') ?? undefined;
        sendHtml(res, 200, renderProposalConfirmationPage(config.authState, jobParam));
        return;
      }

      // Proposals dashboard
      if ((pathname === '/nx/proposals/' || pathname === '/nx/proposals') && method === 'GET') {
        sendHtml(res, 200, renderProposalsDashboardPage(config.authState, submittedProposals));
        return;
      }

      // Messages rooms list
      if (
        (pathname === '/ab/messages/rooms' || pathname === '/ab/messages/rooms/') &&
        method === 'GET'
      ) {
        sendHtml(res, 200, renderMessagesRoomsPage(config.authState, rooms));
        return;
      }

      // Message thread page
      const roomMatch = /^\/ab\/messages\/rooms\/([^/]+)\/?$/.exec(pathname);
      if (roomMatch && method === 'GET') {
        const result = renderMessageThreadPage(config.authState, rooms, roomMatch[1]);
        sendHtml(res, result.status, result.html);
        return;
      }

      // Message send endpoint
      const sendMsgMatch = /^\/api\/mock\/messages\/([^/]+)\/send$/.exec(pathname);
      if (sendMsgMatch && method === 'POST') {
        if (
          config.challenge === 'cloudflare' &&
          (!config.challengeOnPath || matchesPattern(config.challengeOnPath, fullTarget))
        ) {
          sendJson(res, 200, {
            ok: false,
            redirectUrl: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b',
          });
          return;
        }
        const roomId = sendMsgMatch[1];
        const room = resolveRoomById(rooms, roomId);
        if (!room) {
          sendJson(res, 404, { ok: false, error: 'room_not_found' });
          return;
        }
        const payload = (body ? JSON.parse(body) : {}) as { body?: string; sender?: string };
        const entry: MockMessageEntry = {
          id: `msg_sent_${messageSeq}`,
          sender: payload.sender ?? 'Maxx Freelancer',
          body: payload.body ?? '',
          timestamp: new Date().toISOString(),
        };
        messageSeq += 1;
        room.messages.push(entry);
        room.unreadCount = 0;
        sendJson(res, 200, { ok: true, message: entry });
        return;
      }

      // Attachment download stub
      if (pathname.startsWith('/att/') && method === 'GET') {
        const filename = pathname.slice('/att/'.length) || 'attachment.txt';
        const content = `Mock attachment content for ${filename}\n`;
        res.writeHead(200, {
          'content-type': 'text/plain; charset=utf-8',
          'content-length': String(Buffer.byteLength(content)),
        });
        res.end(content);
        return;
      }

      sendHtml(res, 404, '<h1>Not Found</h1>');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const boundPort = addr.port;
  const baseUrl = `http://127.0.0.1:${boundPort}`;

  return {
    port: boundPort,
    baseUrl,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
