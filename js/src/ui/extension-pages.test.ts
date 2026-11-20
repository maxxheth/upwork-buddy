import { fakeBrowser } from '@webext-core/fake-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api';
import { apiUrlItem, authTokenItem, pacingSecondsItem } from '../shared/storage-items';
import { OptionsController } from './options-controller';
import { PopupController } from './popup-controller';
import { SidePanelController } from './sidepanel-controller';
import { TemplateBrowser } from './template-browser';

function mustEl<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}

describe('Extension UI Pages (Side Panel, Popup, Options)', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('OptionsController saves pairing config, custom pacing, and invokes PAIR_AND_RECONNECT', async () => {
    document.body.innerHTML = `
      <form id="options-form">
        <input id="daemon-url" type="url" data-testid="daemon-url-input" />
        <input id="api-token" type="password" data-testid="api-token-input" />
        <input id="pacing-seconds" type="number" data-testid="pacing-seconds-input" />
        <input id="jitter-ratio" type="number" />
        <button id="test-connection-btn" type="button"></button>
        <button id="save-options-btn" type="submit"></button>
        <button id="native-bootstrap-btn" type="button"></button>
      </form>
      <div id="connection-status" data-testid="connection-status"></div>
      <div id="native-host-status"></div>
    `;

    const sendSpy = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (msg) => {
      const m = msg as { type?: string };
      if (m.type === 'PAIR_AND_RECONNECT') {
        return { wsConnected: true, sessionId: 'ext-pair-1' };
      }
      return { wsConnected: false };
    });

    const controller = new OptionsController({
      form: document.getElementById('options-form') as HTMLFormElement,
      urlInput: document.getElementById('daemon-url') as HTMLInputElement,
      tokenInput: document.getElementById('api-token') as HTMLInputElement,
      pacingInput: document.getElementById('pacing-seconds') as HTMLInputElement,
      jitterInput: document.getElementById('jitter-ratio') as HTMLInputElement,
      testBtn: document.getElementById('test-connection-btn') as HTMLButtonElement,
      saveBtn: document.getElementById('save-options-btn') as HTMLButtonElement,
      nativeBtn: document.getElementById('native-bootstrap-btn') as HTMLButtonElement,
      statusBanner: mustEl('connection-status'),
      nativeStatusEl: mustEl('native-host-status'),
    });

    await controller.init();

    (document.getElementById('daemon-url') as HTMLInputElement).value = 'http://127.0.0.1:44555';
    (document.getElementById('api-token') as HTMLInputElement).value = 'secret-tok-77';
    (document.getElementById('pacing-seconds') as HTMLInputElement).value = '0.1';

    await controller.handleSaveAndConnect();

    expect(await apiUrlItem.getValue()).toBe('http://127.0.0.1:44555');
    expect(await authTokenItem.getValue()).toBe('secret-tok-77');
    expect(await pacingSecondsItem.getValue()).toBe(0.1);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PAIR_AND_RECONNECT',
        apiBaseUrl: 'http://127.0.0.1:44555',
        apiToken: 'secret-tok-77',
        pacingSeconds: 0.1,
      }),
    );
    expect(document.getElementById('connection-status')?.textContent).toContain('ext-pair-1');
  });

  it('PopupController renders daemon/policy/pending counts, challenge banner, and Kill Switch', async () => {
    document.body.innerHTML = `
      <span id="daemon-status" data-testid="daemon-status"></span>
      <strong id="policy-mode" data-testid="policy-mode"></strong>
      <strong id="pending-approvals-count" data-testid="pending-approvals-count"></strong>
      <div id="human-action-banner" data-testid="human-action-banner" hidden></div>
      <button id="open-sidepanel-btn" type="button"></button>
      <button id="kill-switch-btn" type="button"></button>
      <button id="start-server-btn" type="button"></button>
      <button id="open-options-btn" type="button"></button>
      <p id="popup-feedback"></p>
    `;

    const sendSpy = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (msg) => {
      const m = msg as { type?: string; url?: string };
      if (m.type === 'GET_RUNTIME_STATUS') {
        return {
          wsConnected: true,
          policyMode: 'confirm_in_ui',
          pendingApprovalsCount: 2,
          humanActionRequired: true,
          activeChallenge: 'cloudflare: captcha',
        };
      }
      if (m.type === 'API_PROXY_REQUEST' && m.url?.includes('/api/proposals')) {
        const body = JSON.stringify({ proposals: [{ id: 1 }, { id: 2 }] });
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          contentType: 'application/json',
          bodyBase64: Buffer.from(body).toString('base64'),
        };
      }
      if (m.type === 'API_PROXY_REQUEST' && m.url?.includes('/api/session/status')) {
        const body = JSON.stringify({ extension_connected: true, policy_mode: 'confirm_in_ui' });
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          contentType: 'application/json',
          bodyBase64: Buffer.from(body).toString('base64'),
        };
      }
      if (m.type === 'TRIGGER_KILL_SWITCH') {
        return { ok: true, aborted: true, policyMode: 'draft_only' };
      }
      return { ok: true };
    });

    const controller = new PopupController({
      daemonStatusEl: mustEl('daemon-status'),
      policyModeEl: mustEl('policy-mode'),
      pendingCountEl: mustEl('pending-approvals-count'),
      challengeBannerEl: mustEl('human-action-banner'),
      openSidePanelBtn: document.getElementById('open-sidepanel-btn') as HTMLButtonElement,
      killSwitchBtn: document.getElementById('kill-switch-btn') as HTMLButtonElement,
      startServerBtn: document.getElementById('start-server-btn') as HTMLButtonElement,
      openOptionsBtn: document.getElementById('open-options-btn') as HTMLButtonElement,
      feedbackEl: mustEl('popup-feedback'),
    });

    await controller.init();
    expect(document.getElementById('daemon-status')?.textContent).toBe('Connected');
    expect(document.getElementById('policy-mode')?.textContent).toBe('confirm_in_ui');
    expect(document.getElementById('pending-approvals-count')?.textContent).toBe('2');
    expect((document.getElementById('human-action-banner') as HTMLElement).hidden).toBe(false);

    await controller.handleKillSwitch();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'TRIGGER_KILL_SWITCH' }));
    expect(document.getElementById('policy-mode')?.textContent).toBe('draft_only');
  });

  it('SidePanelController switches across all 6 tabs and renders CSP-safe escaped HTML', async () => {
    document.body.innerHTML = `
      <span id="sp-connection-pill"></span>
      <span id="sp-policy-badge"></span>
      <button id="sp-kill-switch-btn" type="button"></button>
      <span id="sp-approvals-badge"></span>
      <span id="sp-unread-badge"></span>
      <button class="sp-tab" data-tab="pipeline"></button>
      <button class="sp-tab" data-tab="approvals"></button>
      <button class="sp-tab" data-tab="messages"></button>
      <button class="sp-tab" data-tab="activity"></button>
      <button class="sp-tab" data-tab="agents"></button>
      <button class="sp-tab" data-tab="selectors"></button>
      <main id="sidepanel-content"></main>
    `;

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => ({
      wsConnected: true,
      policyMode: 'confirm_in_ui',
      pendingApprovalsCount: 1,
      recentActivity: [
        {
          id: '1',
          timestamp: '2026-11-19',
          source: 'ws',
          action: 'connected',
          detail: 'ok',
          status: 'ok',
        },
      ],
    }));

    const mockTransport = vi.fn(async (url: string) => {
      if (url.startsWith('/api/jobs')) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                id: 10,
                job_title: '<img src=x onerror=alert(1)> Go Engineer',
                job_description: 'Build MCP server',
                url: 'javascript:alert(2)',
                score: 92,
                fit_label: 'hot',
                skills: 'Go',
                budget: '$2000',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/proposals')) {
        return new Response(
          JSON.stringify({
            proposals: [
              {
                id: 5,
                job_title: 'Test Proposal',
                cover_letter: 'Ready to start',
                bid_type: 'fixed',
                bid_amount: 1500,
                connects_required: 12,
                boost_connects: 4,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/messages/threads')) {
        return new Response(
          JSON.stringify({
            threads: [
              {
                upwork_room_id: 'room-1',
                client_name: 'Bob',
                unread_count: 3,
                last_message_snippet: 'Sounds good',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/policy')) {
        return new Response(
          JSON.stringify({
            mode: 'confirm_in_ui',
            proposals_today: 1,
            max_proposals_per_day: 5,
            connects_today: 16,
            max_connects_per_day: 50,
            messages_today: 0,
            max_messages_per_day: 20,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/selector-audits')) {
        return new Response(
          JSON.stringify({
            audits: [
              {
                id: 1,
                view_type: 'job_detail',
                overall_status: 'HEALTHY',
                created_at: '2026-11-19T12:00:00Z',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const controller = new SidePanelController(
      {
        root: document,
        connectionPill: mustEl('sp-connection-pill'),
        policyBadge: mustEl('sp-policy-badge'),
        killSwitchBtn: document.getElementById('sp-kill-switch-btn') as HTMLButtonElement,
        approvalsBadge: mustEl('sp-approvals-badge'),
        unreadBadge: mustEl('sp-unread-badge'),
        tabButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.sp-tab')),
        contentEl: mustEl('sidepanel-content'),
      },
      { proxyTransport: mockTransport },
    );

    await controller.init();
    const content = mustEl('sidepanel-content');
    // XSS payload escaped & javascript: URL rejected
    expect(content.querySelector('img')).toBeNull();
    expect(content.innerHTML).not.toMatch(/<img/i);
    expect(content.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(content.innerHTML).not.toMatch(/javascript:/i);
    expect(content.innerHTML).toContain('92 hot');

    await controller.switchTab('approvals');
    expect(content.innerHTML).toContain('16 Connects');
    expect(content.querySelector('[data-testid="approve-submit-btn"]')).not.toBeNull();

    await controller.switchTab('messages');
    expect(document.getElementById('sp-unread-badge')?.textContent).toBe('3');

    await controller.switchTab('activity');
    expect(content.innerHTML).toContain('1 / 5');

    await controller.switchTab('agents');
    expect(content.querySelector('[data-testid="tab-blueprints"]')).not.toBeNull();

    await controller.switchTab('selectors');
    expect(content.innerHTML).toContain('HEALTHY');
    expect(content.querySelector('[data-testid="refresh-selectors-btn"]')).not.toBeNull();
    expect(content.querySelector('[data-testid="audit-current-tab-btn"]')).not.toBeNull();
  });

  it('SidePanelController Pipeline Queue exposes ready/review fit options, triggers search/enrich, and renders escaped Selector Health reports', async () => {
    document.body.innerHTML = `
      <span id="sp-connection-pill"></span>
      <span id="sp-policy-badge"></span>
      <button id="sp-kill-switch-btn" type="button"></button>
      <span id="sp-approvals-badge"></span>
      <span id="sp-unread-badge"></span>
      <button class="sp-tab" data-tab="pipeline"></button>
      <button class="sp-tab" data-tab="approvals"></button>
      <button class="sp-tab" data-tab="messages"></button>
      <button class="sp-tab" data-tab="activity"></button>
      <button class="sp-tab" data-tab="agents"></button>
      <button class="sp-tab" data-tab="selectors"></button>
      <main id="sidepanel-content"></main>
    `;

    const runtimeSpy = vi
      .spyOn(fakeBrowser.runtime, 'sendMessage')
      .mockImplementation(async (msg) => {
        const m = msg as { type?: string };
        if (m.type === 'BG_RUN_SELECTOR_AUDIT') {
          return { ok: true, overall_status: 'FRAGILE' };
        }
        return { wsConnected: true, policyMode: 'confirm_in_ui', pendingApprovalsCount: 0 };
      });

    const calls: Array<{ url: string; method: string }> = [];
    const mockTransport = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET' });
      if (url.startsWith('/api/search-profiles')) {
        return new Response(
          JSON.stringify({
            profiles: [
              {
                id: 7,
                name: 'golang_sniper',
                description: 'Go jobs',
                config: { name: 'golang_sniper', search: { mode: 'live_search', query: 'golang' } },
                is_active: true,
              },
              {
                id: 8,
                name: 'legacy_partial_profile',
                description: 'Missing nested search',
                config: {},
                is_active: true,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === '/api/jobs/search') {
        return new Response(JSON.stringify({ jobs: [{ id: 1 }], stopped_reason: 'completed' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url === '/api/jobs/detail') {
        return new Response(JSON.stringify({ enriched_count: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.startsWith('/api/jobs')) {
        return new Response(
          JSON.stringify({
            jobs: [
              {
                id: 42,
                job_title: 'Go Architect',
                job_description: 'Build MCP',
                canonical_url: 'https://www.upwork.com/jobs/~022115332344639171/',
                upwork_job_id: '~022115332344639171',
                score: 88,
                fit_label: 'hot',
                skills: 'Go',
                budget: '$80/hr',
                proposals_tier: '5 to 10',
                connects_required: 12,
                payment_verified: true,
                screening_questions: [
                  { index: 0, prompt: '<script>xss</script>Why Go?', required: true },
                ],
                attachments: [
                  { filename: 'spec.pdf', url: 'https://www.upwork.com/att/1/spec.pdf' },
                ],
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.startsWith('/api/selector-audits')) {
        return new Response(
          JSON.stringify({
            audits: [
              {
                id: 3,
                view_type: 'search_results',
                overall_status: 'FRAGILE',
                created_at: '2026-11-19T12:00:00Z',
                report: {
                  timestamp: '2026-11-19T12:00:00Z',
                  url: 'https://www.upwork.com/nx/search/jobs/',
                  view_type: 'search_results',
                  is_authenticated: true,
                  healthy_selectors_count: 10,
                  degraded_selectors_count: 0,
                  broken_selectors_count: 0,
                  fragile_selectors_count: 1,
                  audits: [
                    {
                      target_field: 'posted',
                      view: 'search_listings',
                      registered_selector: "[data-test='job-pubilshed-date'] span",
                      status: 'FRAGILE',
                      matched_count: 5,
                      sample_extracted_value: '<b>Posted</b>',
                      notes: 'Legacy typo',
                      suggested_replacement: "[data-test='job-published-date'] span",
                    },
                  ],
                  discovered_candidates: [],
                  breaking_changes_detected: ['FRAGILE: search_listings.posted'],
                  baseline_diffs: [],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const controller = new SidePanelController(
      {
        root: document,
        connectionPill: mustEl('sp-connection-pill'),
        policyBadge: mustEl('sp-policy-badge'),
        killSwitchBtn: document.getElementById('sp-kill-switch-btn') as HTMLButtonElement,
        approvalsBadge: mustEl('sp-approvals-badge'),
        unreadBadge: mustEl('sp-unread-badge'),
        tabButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.sp-tab')),
        contentEl: mustEl('sidepanel-content'),
      },
      { proxyTransport: mockTransport },
    );

    await controller.init();
    const content = mustEl('sidepanel-content');
    const fitOptions = Array.from(content.querySelectorAll('#sp-filter-fit option')).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(fitOptions).toEqual(['', 'hot', 'ready', 'review', 'skip']);
    expect(content.innerHTML).toContain('12 Connects');
    expect(content.innerHTML).toContain('Verified');

    // Open details and confirm XSS escaping
    content.querySelector<HTMLButtonElement>('.js-view-job')?.click();
    expect(content.querySelector('script')).toBeNull();
    expect(content.innerHTML).toContain('&lt;script&gt;xss&lt;/script&gt;Why Go?');

    // Run Search
    (content.querySelector('#sp-search-query') as HTMLInputElement).value = 'golang';
    content.querySelector<HTMLButtonElement>('[data-testid="run-search-btn"]')?.click();
    await new Promise((r) => setTimeout(r, 15));
    expect(calls.some((c) => c.url === '/api/jobs/search' && c.method === 'POST')).toBe(true);

    // Enrich button
    content.querySelector<HTMLButtonElement>('[data-testid="enrich-job-btn"]')?.click();
    await new Promise((r) => setTimeout(r, 15));
    expect(calls.some((c) => c.url === '/api/jobs/detail' && c.method === 'POST')).toBe(true);

    // Switch to Selector Health tab and trigger Audit Current Tab
    await controller.switchTab('selectors');
    expect(content.innerHTML).toContain('Healthy: 10 | Degraded: 0 | Broken: 0 | Fragile: 1');
    expect(content.innerHTML).toContain('&lt;b&gt;Posted&lt;/b&gt;');
    content.querySelector<HTMLButtonElement>('[data-testid="audit-current-tab-btn"]')?.click();
    await new Promise((r) => setTimeout(r, 15));
    expect(runtimeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BG_RUN_SELECTOR_AUDIT' }),
    );
  });

  it('SidePanelController Selector Health safely renders a partial SelectorAuditRow.report without crashing', async () => {
    document.body.innerHTML = `
      <span id="sp-connection-pill"></span>
      <span id="sp-policy-badge"></span>
      <button id="sp-kill-switch-btn" type="button"></button>
      <span id="sp-approvals-badge"></span>
      <span id="sp-unread-badge"></span>
      <button class="sp-tab" data-tab="pipeline"></button>
      <button class="sp-tab" data-tab="approvals"></button>
      <button class="sp-tab" data-tab="messages"></button>
      <button class="sp-tab" data-tab="activity"></button>
      <button class="sp-tab" data-tab="agents"></button>
      <button class="sp-tab" data-tab="selectors"></button>
      <main id="sidepanel-content"></main>
    `;

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => ({
      wsConnected: true,
      policyMode: 'confirm_in_ui',
      pendingApprovalsCount: 0,
    }));

    const mockTransport = vi.fn(async (url: string) => {
      if (url.startsWith('/api/selector-audits')) {
        return new Response(
          JSON.stringify({
            audits: [
              {
                id: 9,
                view_type: 'search_listings',
                overall_status: 'HEALTHY',
                created_at: '2026-11-19T12:00:00Z',
                report: {
                  view_type: 'search_listings',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    });

    const controller = new SidePanelController(
      {
        root: document,
        connectionPill: mustEl('sp-connection-pill'),
        policyBadge: mustEl('sp-policy-badge'),
        killSwitchBtn: document.getElementById('sp-kill-switch-btn') as HTMLButtonElement,
        approvalsBadge: mustEl('sp-approvals-badge'),
        unreadBadge: mustEl('sp-unread-badge'),
        tabButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.sp-tab')),
        contentEl: mustEl('sidepanel-content'),
      },
      { proxyTransport: mockTransport },
    );

    await controller.init();
    await controller.switchTab('selectors');

    const content = mustEl('sidepanel-content');
    expect(content.innerHTML).toContain('Healthy: 0 | Degraded: 0 | Broken: 0 | Fragile: 0');
    expect(content.innerHTML).toContain('Selector Rules (0)');
  });

  it('M5: SidePanel renders header budget gauges on initial load, handles null pipeline fields, displays approval errors/success, and shows pending reply approvals cleanly', async () => {
    document.body.innerHTML = `
      <span id="sp-connection-pill"></span>
      <span id="sp-policy-badge"></span>
      <button id="sp-kill-switch-btn" type="button"></button>
      <div id="sp-budget-bar">
        <strong id="sp-budget-proposals">0 / 5</strong>
        <strong id="sp-budget-connects">0 / 50</strong>
        <strong id="sp-budget-messages">0 / 20</strong>
      </div>
      <span id="sp-approvals-badge"></span>
      <span id="sp-unread-badge"></span>
      <button class="sp-tab" data-tab="pipeline"></button>
      <button class="sp-tab" data-tab="approvals"></button>
      <button class="sp-tab" data-tab="messages"></button>
      <button class="sp-tab" data-tab="activity"></button>
      <button class="sp-tab" data-tab="agents"></button>
      <button class="sp-tab" data-tab="selectors"></button>
      <main id="sidepanel-content"></main>
    `;

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => ({
      wsConnected: true,
      policyMode: 'confirm_in_ui',
      pendingApprovalsCount: 1,
    }));

    let approvePropAttempt = 0;
    let draftsList: Array<{
      id: number;
      upwork_room_id: string;
      client_name: string;
      body: string;
    }> = [
      { id: 88, upwork_room_id: 'room_alpha', client_name: 'Alice', body: 'Yes Monday works!' },
    ];
    let proposalsList = [
      {
        id: 12,
        job_title: 'Go MCP Server',
        cover_letter: 'Ready to build',
        bid_type: 'fixed',
        bid_amount: 1400,
        connects_required: 12,
        boost_connects: 4,
        total_connects: 16,
        verification_snapshot_json: {
          cover_letter_length: 14,
          estimated_fee: 140,
          estimated_net: 1260,
          unanswered_required_questions: 1,
          screening_answers: [{ prompt: 'Go years?', answer: '', required: true }],
        },
      },
    ];

    const mockTransport = vi.fn(async (url: string) => {
      if (url === '/api/policy') {
        return new Response(
          JSON.stringify({
            mode: 'confirm_in_ui',
            proposals_today: 1,
            max_proposals_per_day: 1,
            connects_today: 10,
            max_connects_per_day: 20,
            messages_today: 0,
            max_messages_per_day: 5,
            pending_approvals: proposalsList.length + draftsList.length,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url === '/api/messages/unread') {
        return new Response(JSON.stringify({ total_unread: 4 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs')) {
        return new Response(
          JSON.stringify({
            jobs: [
              { id: 1, job_title: null, job_description: null, skills: null },
              { id: 2, job_title: 'Golang Pipeline', job_description: 'Postgres', skills: ['Go'] },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/proposals?status=pending_approval')) {
        return new Response(JSON.stringify({ proposals: proposalsList }), { status: 200 });
      }
      if (url === '/api/proposals/12/approve') {
        approvePropAttempt += 1;
        if (approvePropAttempt === 1) {
          return new Response(
            JSON.stringify({
              error: '1 required screening question(s) are unanswered',
              error_code: 'SCREENING_QUESTIONS_REQUIRED',
            }),
            { status: 422 },
          );
        }
        proposalsList = [];
        return new Response(JSON.stringify({ submitted: true, status: 'submitted' }), {
          status: 200,
        });
      }
      if (url.startsWith('/api/messages/drafts')) {
        return new Response(JSON.stringify({ drafts: draftsList }), { status: 200 });
      }
      if (url.startsWith('/api/messages/threads')) {
        return new Response(
          JSON.stringify({
            threads: [
              {
                upwork_room_id: 'room_alpha',
                client_name: 'Alice',
                unread_count: 4,
                last_message_snippet: 'Hi',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url === '/api/messages/88/approve') {
        draftsList = [];
        return new Response(JSON.stringify({ sent: true, status: 'sent' }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const controller = new SidePanelController(
      {
        root: document,
        connectionPill: mustEl('sp-connection-pill'),
        policyBadge: mustEl('sp-policy-badge'),
        killSwitchBtn: document.getElementById('sp-kill-switch-btn') as HTMLButtonElement,
        approvalsBadge: mustEl('sp-approvals-badge'),
        unreadBadge: mustEl('sp-unread-badge'),
        tabButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.sp-tab')),
        contentEl: mustEl('sidepanel-content'),
      },
      { proxyTransport: mockTransport },
    );

    await controller.init();
    // T4-03: Header budget gauges visible immediately on initial Pipeline tab
    expect(document.getElementById('sp-budget-proposals')?.textContent).toBe('1 / 1');
    expect(document.getElementById('sp-budget-connects')?.textContent).toBe('10 / 20');
    expect(document.getElementById('sp-unread-badge')?.textContent).toBe('4');

    // M4 Caveat 2: null-safe filterQuery on null job_title/job_description/skills
    const filterInput = document.getElementById('sp-filter-query') as HTMLInputElement;
    filterInput.value = 'golang';
    filterInput.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 15));
    expect(mustEl('sidepanel-content').innerHTML).toContain('Golang Pipeline');

    // Approvals tab: displays snapshot + error on 422 + "submitted" on 200
    await controller.switchTab('approvals');
    const content = mustEl('sidepanel-content');
    expect(content.innerHTML).toContain('1 required screening question(s) unanswered');
    content.querySelector<HTMLButtonElement>('[data-testid="approve-submit-btn"]')?.click();
    await new Promise((r) => setTimeout(r, 15));
    expect(content.innerHTML).toMatch(/screening|unanswered/i);

    content.querySelector<HTMLButtonElement>('[data-testid="approve-submit-btn"]')?.click();
    await new Promise((r) => setTimeout(r, 15));
    expect(content.innerHTML).toMatch(/submitted/i);

    // Messages tab: pending reply card visible immediately, gone after approve, "sent" status shown
    await controller.switchTab('messages');
    expect(content.querySelectorAll('[data-testid="approve-send-btn"]').length).toBe(1);
    content.querySelector<HTMLButtonElement>('[data-testid="approve-send-btn"]')?.click();
    await new Promise((r) => setTimeout(r, 15));
    expect(content.querySelectorAll('[data-testid="approve-send-btn"]').length).toBe(0);
    expect(content.innerHTML).toMatch(/sent/i);
  });

  it('M5-R2: escapes XSS payloads in proposal rate_increase inside SidePanelController.renderSnapshotHtml', async () => {
    document.body.innerHTML = `
      <span id="sp-connection-pill"></span>
      <span id="sp-policy-badge"></span>
      <button id="sp-kill-switch-btn" type="button"></button>
      <span id="sp-approvals-badge"></span>
      <span id="sp-unread-badge"></span>
      <button class="sp-tab" data-tab="pipeline"></button>
      <button class="sp-tab" data-tab="approvals"></button>
      <button class="sp-tab" data-tab="messages"></button>
      <button class="sp-tab" data-tab="activity"></button>
      <button class="sp-tab" data-tab="agents"></button>
      <button class="sp-tab" data-tab="selectors"></button>
      <main id="sidepanel-content"></main>
    `;

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => ({
      wsConnected: true,
      policyMode: 'confirm_in_ui',
      pendingApprovalsCount: 1,
    }));

    const xssPayload = '<img src=x onerror=alert(1)>';
    const mockTransport = vi.fn(async (url: string) => {
      if (url.startsWith('/api/proposals?status=pending_approval')) {
        return new Response(
          JSON.stringify({
            proposals: [
              {
                id: 99,
                job_title: 'Hourly Go Systems',
                cover_letter: 'Ready to start',
                bid_type: 'hourly',
                bid_amount: 95,
                rate_increase: xssPayload,
                verification_snapshot_json: {
                  cover_letter_length: 14,
                  rate_increase: xssPayload,
                  unanswered_required_questions: 0,
                  screening_answers: [],
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ jobs: [], drafts: [], threads: [] }), { status: 200 });
    });

    const controller = new SidePanelController(
      {
        root: document,
        connectionPill: mustEl('sp-connection-pill'),
        policyBadge: mustEl('sp-policy-badge'),
        killSwitchBtn: document.getElementById('sp-kill-switch-btn') as HTMLButtonElement,
        approvalsBadge: mustEl('sp-approvals-badge'),
        unreadBadge: mustEl('sp-unread-badge'),
        tabButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.sp-tab')),
        contentEl: mustEl('sidepanel-content'),
      },
      { proxyTransport: mockTransport },
    );

    await controller.init();
    await controller.switchTab('approvals');
    const content = mustEl('sidepanel-content');
    expect(content.querySelector('img')).toBeNull();
    expect(content.innerHTML).not.toMatch(/<img/i);
    expect(content.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('SidePanelController hides and clears #sp-budget-bar on activity tab and restores counters synchronously when returning to pipeline', async () => {
    document.body.innerHTML = `
      <span id="sp-connection-pill"></span>
      <span id="sp-policy-badge"></span>
      <button id="sp-kill-switch-btn" type="button"></button>
      <div id="sp-budget-bar">
        <strong id="sp-budget-proposals">0 / 5</strong>
        <strong id="sp-budget-connects">0 / 50</strong>
        <strong id="sp-budget-messages">0 / 20</strong>
      </div>
      <span id="sp-approvals-badge"></span>
      <span id="sp-unread-badge"></span>
      <button class="sp-tab" data-tab="pipeline"></button>
      <button class="sp-tab" data-tab="approvals"></button>
      <button class="sp-tab" data-tab="messages"></button>
      <button class="sp-tab" data-tab="activity"></button>
      <button class="sp-tab" data-tab="agents"></button>
      <button class="sp-tab" data-tab="selectors"></button>
      <main id="sidepanel-content"></main>
    `;

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async () => ({
      wsConnected: true,
      policyMode: 'confirm_in_ui',
      pendingApprovalsCount: 0,
    }));

    let proposalsToday = 1;
    const mockTransport = vi.fn(async (url: string) => {
      if (url === '/api/policy') {
        return new Response(
          JSON.stringify({
            mode: 'confirm_in_ui',
            proposals_today: proposalsToday,
            max_proposals_per_day: 5,
            connects_today: 16,
            max_connects_per_day: 50,
            messages_today: 2,
            max_messages_per_day: 20,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ jobs: [], audit_logs: [] }), { status: 200 });
    });

    const controller = new SidePanelController(
      {
        root: document,
        connectionPill: mustEl('sp-connection-pill'),
        policyBadge: mustEl('sp-policy-badge'),
        killSwitchBtn: document.getElementById('sp-kill-switch-btn') as HTMLButtonElement,
        approvalsBadge: mustEl('sp-approvals-badge'),
        unreadBadge: mustEl('sp-unread-badge'),
        tabButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.sp-tab')),
        contentEl: mustEl('sidepanel-content'),
      },
      { proxyTransport: mockTransport },
    );

    await controller.init();
    const budgetBar = mustEl('sp-budget-bar');
    const propEl = mustEl('sp-budget-proposals');
    const connEl = mustEl('sp-budget-connects');
    const msgEl = mustEl('sp-budget-messages');

    expect(budgetBar.style.display).toBe('');
    expect(propEl.textContent).toBe('1 / 5');
    expect(connEl.textContent).toBe('16 / 50');
    expect(msgEl.textContent).toBe('2 / 20');

    await controller.switchTab('activity');
    expect(budgetBar.style.display).toBe('none');
    expect(propEl.textContent).toBe('');
    expect(connEl.textContent).toBe('');
    expect(msgEl.textContent).toBe('');

    proposalsToday = 2;
    const switchBackPromise = controller.switchTab('pipeline');
    // Immediately (synchronously) restored from cached values before async refresh resolves
    expect(budgetBar.style.display).toBe('');
    expect(propEl.textContent).toBe('1 / 5');
    expect(connEl.textContent).toBe('16 / 50');
    expect(msgEl.textContent).toBe('2 / 20');

    await switchBackPromise;
    await new Promise((r) => setTimeout(r, 15));
    expect(propEl.textContent).toBe('2 / 5');
  });

  it('OptionsController attaches submit/dirty listeners synchronously before storage reads resolve', async () => {
    document.body.innerHTML = `
      <form id="options-form">
        <input id="daemon-url" type="url" data-testid="daemon-url-input" />
        <input id="api-token" type="password" data-testid="api-token-input" />
        <input id="pacing-seconds" type="number" data-testid="pacing-seconds-input" />
        <input id="jitter-ratio" type="number" />
        <button id="test-connection-btn" type="button"></button>
        <button id="save-options-btn" type="submit"></button>
        <button id="native-bootstrap-btn" type="button"></button>
      </form>
      <div id="connection-status" data-testid="connection-status"></div>
      <div id="native-host-status"></div>
    `;

    let resolveStoredUrl!: (value: string) => void;
    vi.spyOn(apiUrlItem, 'getValue').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveStoredUrl = resolve;
        }),
    );

    const sendSpy = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (msg) => {
      const m = msg as { type?: string };
      if (m.type === 'PAIR_AND_RECONNECT') {
        return { wsConnected: true, sessionId: 'early-submit-1' };
      }
      return { wsConnected: false };
    });

    const form = document.getElementById('options-form') as HTMLFormElement;
    const urlInput = document.getElementById('daemon-url') as HTMLInputElement;
    const tokenInput = document.getElementById('api-token') as HTMLInputElement;
    const pacingInput = document.getElementById('pacing-seconds') as HTMLInputElement;

    const controller = new OptionsController({
      form,
      urlInput,
      tokenInput,
      pacingInput,
      jitterInput: document.getElementById('jitter-ratio') as HTMLInputElement,
      testBtn: document.getElementById('test-connection-btn') as HTMLButtonElement,
      saveBtn: document.getElementById('save-options-btn') as HTMLButtonElement,
      nativeBtn: document.getElementById('native-bootstrap-btn') as HTMLButtonElement,
      statusBanner: mustEl('connection-status'),
      nativeStatusEl: mustEl('native-host-status'),
    });

    const initPromise = controller.init();

    // User fills and submits synchronously before storage read finishes
    urlInput.value = 'http://127.0.0.1:49999';
    urlInput.dispatchEvent(new Event('input', { bubbles: true }));
    tokenInput.value = 'early-tok-99';
    tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
    pacingInput.value = '0.25';
    pacingInput.dispatchEvent(new Event('input', { bubbles: true }));

    const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(submitEvent);
    expect(submitEvent.defaultPrevented).toBe(true);

    // Resolve delayed storage read with stale value; dirty fields must NOT be overwritten
    resolveStoredUrl('http://127.0.0.1:9090');
    await initPromise;
    await new Promise((r) => setTimeout(r, 15));

    expect(urlInput.value).toBe('http://127.0.0.1:49999');
    expect(tokenInput.value).toBe('early-tok-99');
    expect(pacingInput.value).toBe('0.25');
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'PAIR_AND_RECONNECT',
        apiBaseUrl: 'http://127.0.0.1:49999',
        apiToken: 'early-tok-99',
        pacingSeconds: 0.25,
      }),
    );
    expect(mustEl('connection-status').textContent).toContain('early-submit-1');
  });

  it('OptionsController does not overwrite #connection-status after early #test-connection-btn click when init resolves', async () => {
    document.body.innerHTML = `
      <form id="options-form">
        <input id="daemon-url" type="url" data-testid="daemon-url-input" />
        <input id="api-token" type="password" data-testid="api-token-input" />
        <input id="pacing-seconds" type="number" data-testid="pacing-seconds-input" />
        <input id="jitter-ratio" type="number" />
        <button id="test-connection-btn" type="button"></button>
        <button id="save-options-btn" type="submit"></button>
        <button id="native-bootstrap-btn" type="button"></button>
      </form>
      <div id="connection-status" data-testid="connection-status"></div>
      <div id="native-host-status"></div>
    `;

    let resolveStoredUrl!: (value: string) => void;
    vi.spyOn(apiUrlItem, 'getValue').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveStoredUrl = resolve;
        }),
    );

    vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (msg) => {
      const m = msg as { type?: string };
      if (m.type === 'TEST_CONNECTION') {
        return { ok: true, healthStatus: 200, authStatus: 200 };
      }
      if (m.type === 'GET_RUNTIME_STATUS') {
        return { wsConnected: false };
      }
      return {};
    });

    const controller = new OptionsController({
      form: document.getElementById('options-form') as HTMLFormElement,
      urlInput: document.getElementById('daemon-url') as HTMLInputElement,
      tokenInput: document.getElementById('api-token') as HTMLInputElement,
      pacingInput: document.getElementById('pacing-seconds') as HTMLInputElement,
      jitterInput: document.getElementById('jitter-ratio') as HTMLInputElement,
      testBtn: document.getElementById('test-connection-btn') as HTMLButtonElement,
      saveBtn: document.getElementById('save-options-btn') as HTMLButtonElement,
      nativeBtn: document.getElementById('native-bootstrap-btn') as HTMLButtonElement,
      statusBanner: mustEl('connection-status'),
      nativeStatusEl: mustEl('native-host-status'),
    });

    const initPromise = controller.init();

    // User clicks Test Connection before delayed storage read resolves
    (document.getElementById('test-connection-btn') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(mustEl('connection-status').textContent).toBe('Connection OK (/health=200, auth=200)');

    // Storage resolves later; refreshStatus() must NOT overwrite the test result
    resolveStoredUrl('http://127.0.0.1:9090');
    await initPromise;
    await new Promise((r) => setTimeout(r, 10));

    expect(mustEl('connection-status').textContent).toBe('Connection OK (/health=200, auth=200)');
  });

  it('SidePanelController agents tab and TemplateBrowser fetch GET /api/agents and render persisted blueprints', async () => {
    document.body.innerHTML = `
      <span id="sp-connection-pill"></span>
      <span id="sp-policy-badge"></span>
      <button id="sp-kill-switch-btn" type="button"></button>
      <span id="sp-approvals-badge"></span>
      <span id="sp-unread-badge"></span>
      <button class="sp-tab" data-tab="pipeline"></button>
      <button class="sp-tab" data-tab="approvals"></button>
      <button class="sp-tab" data-tab="messages"></button>
      <button class="sp-tab" data-tab="activity"></button>
      <button class="sp-tab" data-tab="agents"></button>
      <button class="sp-tab" data-tab="selectors"></button>
      <main id="sidepanel-content"></main>
    `;

    const persistedAgents = [
      {
        blueprint_name: 'go-api-agent',
        file_name: 'go-api-agent.md',
        template_name: 'golang',
        format: 'copilot',
        content: '# Go API Agent\nFollow Go conventions.',
        generated_at: '2026-11-20T08:00:00Z',
      },
    ];

    const mockTransport = vi.fn(async (url: string) => {
      if (url.endsWith('/api/agents')) {
        return new Response(JSON.stringify({ agents: persistedAgents }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/templates')) {
        return new Response(
          JSON.stringify({
            templates: [
              {
                name: 'golang',
                display_name: 'Go Backend',
                description: 'Go services',
                icon: '🐹',
                agent_count: 2,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/profile')) {
        return new Response(
          JSON.stringify({ description: 'Go dev', skills: 'Go', portfolio_items: [] }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const controller = new SidePanelController(
      {
        root: document,
        connectionPill: mustEl('sp-connection-pill'),
        policyBadge: mustEl('sp-policy-badge'),
        killSwitchBtn: document.getElementById('sp-kill-switch-btn') as HTMLButtonElement,
        approvalsBadge: mustEl('sp-approvals-badge'),
        unreadBadge: mustEl('sp-unread-badge'),
        tabButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.sp-tab')),
        contentEl: mustEl('sidepanel-content'),
      },
      { proxyTransport: mockTransport },
    );

    await controller.switchTab('agents');
    const content = mustEl('sidepanel-content');
    expect(content.querySelector('[data-testid="tab-blueprints"]')).not.toBeNull();
    expect(
      content.querySelector('[data-testid="persisted-agents-summary"]')?.textContent,
    ).toContain('go-api-agent');
    expect(mockTransport).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/agents$/),
      expect.objectContaining({ method: 'GET' }),
    );

    // TemplateBrowser directly renders persisted agents alongside templates
    const browserContainer = document.createElement('div');
    const apiClient = new ApiClient(mockTransport);
    await new TemplateBrowser(apiClient, browserContainer).render();
    expect(browserContainer.textContent).toContain('Go Backend');
    expect(browserContainer.textContent).toContain('go-api-agent');
    expect(browserContainer.querySelectorAll('[data-testid="persisted-agent-item"]')).toHaveLength(
      1,
    );
  });

  it('SidePanelController escapes HTML payloads in verification snapshot estimated_fee and estimated_net', () => {
    document.body.innerHTML = `
      <span id="sp-connection-pill"></span>
      <span id="sp-policy-badge"></span>
      <button id="sp-kill-switch-btn" type="button"></button>
      <span id="sp-approvals-badge"></span>
      <span id="sp-unread-badge"></span>
      <main id="sidepanel-content"></main>
    `;
    const ctrl = new SidePanelController({
      root: document,
      connectionPill: mustEl('sp-connection-pill'),
      policyBadge: mustEl('sp-policy-badge'),
      killSwitchBtn: document.getElementById('sp-kill-switch-btn') as HTMLButtonElement,
      approvalsBadge: mustEl('sp-approvals-badge'),
      unreadBadge: mustEl('sp-unread-badge'),
      tabButtons: [],
      contentEl: mustEl('sidepanel-content'),
    });
    const html = (
      ctrl as unknown as { renderSnapshotHtml: (p: unknown) => string }
    ).renderSnapshotHtml({
      id: 1,
      verification_snapshot_json: JSON.stringify({
        estimated_fee: '<img src=x onerror=window.__xss=1>',
        estimated_net: '<svg onload=window.__xss=2>',
      }),
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<svg');
    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;svg');
  });

  it('SidePanelController Selectors Workbench captures active tab, tests & applies patches, copies markdown, rolls back, and honors pending tab', async () => {
    document.body.innerHTML = `
      <span id="sp-connection-pill"></span>
      <span id="sp-policy-badge"></span>
      <button id="sp-kill-switch-btn" type="button"></button>
      <span id="sp-approvals-badge"></span>
      <span id="sp-unread-badge"></span>
      <span id="sp-budget-proposals"></span>
      <span id="sp-budget-connects"></span>
      <span id="sp-budget-messages"></span>
      <button class="sp-tab" data-tab="pipeline"></button>
      <button class="sp-tab" data-tab="selectors"></button>
      <main id="sidepanel-content"></main>
    `;

    const capturePayload = {
      capture_uid: 'cap_20261120_skills',
      captured_at: '2026-11-20T09:00:00Z',
      url: 'https://www.upwork.com/jobs/~02123/',
      title: 'Senior Go Engineer',
      view_type: 'job_detail',
      scope: 'drawer',
      is_authenticated: true,
      overall_status: 'BROKEN',
      redact_pii: true,
      audit_report: {
        view_type: 'job_detail',
        url: 'https://www.upwork.com/jobs/~02123/',
        timestamp: '2026-11-20T09:00:00Z',
        is_authenticated: true,
        overall_status: 'BROKEN',
        healthy_selectors_count: 5,
        degraded_selectors_count: 0,
        broken_selectors_count: 1,
        fragile_selectors_count: 0,
        audits: [],
        discovered_candidates: [],
        baseline_diffs: [],
      },
      blueprint: {
        view_type: 'job_detail',
        url: 'https://www.upwork.com/jobs/~02123/',
        captured_at: '2026-11-20T09:00:00Z',
        is_authenticated: true,
        landmarks: [],
        attribute_hooks: [],
        captured_xhr_endpoints: [],
      },
      landmarks: [],
      repetitive_patterns: [],
      broken_fields: [
        {
          field: 'skills',
          view: 'job_detail',
          status: 'BROKEN',
          registered_selector: '[data-test="Skill"]',
          matched_count: 0,
          notes: 'Matched 0 nodes',
          nearest_heading: 'Skills and Expertise',
          anchor_html:
            '<ul class="new-skill-chips"><li class="air3-skill-chip"><span>Go</span></li></ul>',
          candidates: [
            {
              selector: '.air3-skill-chip span',
              stability_score: 88,
              matched_count: 3,
              sample_value: ['Go', 'PostgreSQL', 'Playwright'],
              strategy: 'repetitive_pattern_leaf',
              is_fragile: false,
              reason: 'Matched 3 nodes',
            },
          ],
        },
      ],
      pruned_html: '<main></main>',
      passive_graphql_ops: [],
    };

    const writeTextSpy = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: writeTextSpy },
    });

    const sendSpy = vi.spyOn(fakeBrowser.runtime, 'sendMessage').mockImplementation(async (msg) => {
      const m = msg as { type?: string };
      if (m.type === 'BG_GET_PENDING_SIDEPANEL_TAB') return { tab: 'selectors' };
      if (m.type === 'GET_RUNTIME_STATUS') {
        return { wsConnected: true, policyMode: 'confirm_in_ui', pendingApprovalsCount: 0 };
      }
      if (m.type === 'BG_CAPTURE_UI_DIAGNOSTIC') {
        return {
          ok: true,
          capture_uid: 'cap_20261120_skills',
          markdown: '# UI Diagnostic Capture: job_detail',
          capture: capturePayload,
        };
      }
      if (m.type === 'BG_TEST_SELECTOR_PATCH') {
        return {
          ok: true,
          view: 'job_detail',
          field: 'skills',
          matched_count: 3,
          sample_value: ['Go', 'PostgreSQL', 'Playwright'],
          status: 'HEALTHY',
          regressions: [],
          before_summary: {
            status: 'BROKEN',
            matched_count: 0,
            sample_value: null,
            matched_selector: null,
          },
          after_summary: {
            status: 'HEALTHY',
            matched_count: 3,
            sample_value: ['Go', 'PostgreSQL', 'Playwright'],
            matched_selector: '.air3-skill-chip span',
          },
        };
      }
      if (m.type === 'BG_APPLY_SELECTOR_PATCH') {
        return { ok: true, new_version: '2.0.1', backup_file: 'upwork.20261120.yaml' };
      }
      if (m.type === 'BG_ROLLBACK_SELECTOR_PATCH') {
        return { ok: true, version: '2.0', backup_file: 'upwork.20261120.yaml' };
      }
      return { ok: true };
    });

    const mockTransport = vi.fn(async (url: string) => {
      if (url.startsWith('/api/selector-audits')) {
        return new Response(JSON.stringify({ audits: [] }), { status: 200 });
      }
      if (url.startsWith('/api/diagnostics/captures/cap_20261120_skills')) {
        return new Response(
          JSON.stringify({
            capture_uid: 'cap_20261120_skills',
            markdown: '# UI Diagnostic Capture: job_detail',
            capture: capturePayload,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/diagnostics/captures')) {
        return new Response(
          JSON.stringify({
            captures: [
              {
                id: 1,
                capture_uid: 'cap_20261120_skills',
                view_type: 'job_detail',
                overall_status: 'BROKEN',
                broken_count: 1,
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const controller = new SidePanelController(
      {
        root: document,
        connectionPill: mustEl('sp-connection-pill'),
        policyBadge: mustEl('sp-policy-badge'),
        killSwitchBtn: document.getElementById('sp-kill-switch-btn') as HTMLButtonElement,
        approvalsBadge: mustEl('sp-approvals-badge'),
        unreadBadge: mustEl('sp-unread-badge'),
        tabButtons: Array.from(document.querySelectorAll<HTMLButtonElement>('.sp-tab')),
        contentEl: mustEl('sidepanel-content'),
      },
      { proxyTransport: mockTransport },
    );

    await controller.init();
    expect(controller.getActiveTab()).toBe('selectors');

    const content = mustEl('sidepanel-content');
    expect(
      content.querySelector('[data-testid="failing-fields-inspector"]')?.textContent,
    ).toContain('job_detail.skills');

    content.querySelector<HTMLButtonElement>('[data-testid="copy-diagnostic-md-btn"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(writeTextSpy).toHaveBeenCalledWith('# UI Diagnostic Capture: job_detail');

    content.querySelector<HTMLButtonElement>('[data-testid="capture-active-tab-btn"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BG_CAPTURE_UI_DIAGNOSTIC', useActiveTab: true }),
    );

    content.querySelector<HTMLButtonElement>('.js-test-patch')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'BG_TEST_SELECTOR_PATCH',
        view: 'job_detail',
        field: 'skills',
      }),
    );
    expect(content.querySelector('#sp-patch-feedback-0')?.textContent).toContain(
      'HEALTHY: 3 match(es)',
    );

    content.querySelector<HTMLButtonElement>('.js-apply-patch')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'BG_APPLY_SELECTOR_PATCH',
        view: 'job_detail',
        field: 'skills',
      }),
    );

    content.querySelector<HTMLButtonElement>('[data-testid="rollback-patch-btn"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BG_ROLLBACK_SELECTOR_PATCH' }),
    );
    expect(content.querySelector('#sp-selectors-status')?.textContent).toContain(
      'Rolled back selectors to v2.0',
    );
  });
});
