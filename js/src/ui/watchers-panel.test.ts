import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiTransport,
  NotificationConfig,
  WatchersStatusResponse,
  WatchEvent,
  WatchRule,
  WatchRun,
} from '../types';
import { DashboardController } from './dashboard-controller';
import { WatchersPanel } from './watchers-panel';

function makeRule(overrides: Partial<WatchRule> = {}): WatchRule {
  return {
    id: 1,
    name: 'Go + Postgres Hourly',
    description: 'Watch high-rate Go jobs',
    enabled: true,
    discovery_backend: 'chrome',
    search_profile_id: null,
    discovery_config: {
      source: 'search',
      queries: ['go postgresql'],
      contract_type: 'hourly',
      payment_verified_only: true,
    },
    interval_minutes: 15,
    jitter_ratio: 0.15,
    active_hours: '08:00-22:00',
    min_score: 70,
    max_proposals: 15,
    max_posted_age_minutes: 60,
    max_connects_per_job: 12,
    require_payment_verified: true,
    required_keywords: ['go'],
    exclude_keywords: ['wordpress'],
    action_mode: 'draft_and_fill',
    llm_model: '',
    llm_effort: '',
    bid_strategy: { hourly_rate: 95 },
    auto_submit_min_confidence: 0.85,
    fallback_on_screening_questions: true,
    max_reactions_per_tick: 3,
    seed_baseline_on_first_run: true,
    seeded_at: '2026-11-22T09:00:00Z',
    paused_reason: '',
    consecutive_errors: 0,
    next_run_at: '2026-11-22T10:15:00Z',
    last_run_at: '2026-11-22T10:00:00Z',
    last_success_at: '2026-11-22T10:00:00Z',
    last_error: '',
    created_at: '2026-11-22T08:00:00Z',
    updated_at: '2026-11-22T10:00:00Z',
    ...overrides,
  };
}

function makeStatus(overrides: Partial<WatchersStatusResponse> = {}): WatchersStatusResponse {
  return {
    running: true,
    active_rules: 1,
    paused_rules: 0,
    active_reactions: 0,
    scraper_fs_available: false,
    scraper_fs_dir: '/var/www/upwork-scraper-fs',
    scraper_fs_reason: 'FlareSolverr not reachable',
    ...overrides,
  };
}

function makeNotifConfig(overrides: Partial<NotificationConfig> = {}): NotificationConfig {
  return {
    chrome_notifications_enabled: true,
    webhook_enabled: true,
    webhook_url: 'https://hooks.example.com/upwork',
    has_webhook_secret: true,
    telegram_enabled: false,
    has_telegram_bot_token: true,
    telegram_chat_id: '123456',
    notify_events: ['hot_job_alert', 'pending_approval'],
    updated_at: '2026-11-22T09:00:00Z',
    ...overrides,
  };
}

describe('WatchersPanel', () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="watchers-root"></div>';
    root = document.getElementById('watchers-root') as HTMLElement;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders status header, rules with backend/action badges, and masked notification secrets', async () => {
    const rules = [
      makeRule({ id: 1, name: 'Chrome Watcher', discovery_backend: 'chrome', action_mode: 'draft_and_fill' }),
      makeRule({
        id: 2,
        name: 'ScraperFS Watcher',
        discovery_backend: 'scraper_fs',
        action_mode: 'alert_only',
        paused_reason: 'HUMAN_ACTION_REQUIRED',
      }),
    ];
    const transport: ApiTransport = vi.fn(async (url) => {
      if (url === '/api/watchers/status') {
        return new Response(JSON.stringify(makeStatus({ active_rules: 1, paused_rules: 1 })), { status: 200 });
      }
      if (url === '/api/watchers') {
        return new Response(JSON.stringify({ rules }), { status: 200 });
      }
      if (url === '/api/notifications/config') {
        return new Response(JSON.stringify({ config: makeNotifConfig() }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const panel = new WatchersPanel(root, transport);
    await panel.init();

    expect(root.querySelector('[data-testid="watchers-daemon-status"]')?.textContent).toContain('Daemon Running');
    expect(root.querySelector('[data-testid="watchers-counts-pill"]')?.textContent).toContain('1 active · 1 paused');
    expect(root.querySelector('[data-testid="watchers-scraper-fs-status"]')?.textContent).toContain(
      'FlareSolverr not reachable',
    );

    const cards = root.querySelectorAll('[data-testid="watcher-rule-card"]');
    expect(cards.length).toBe(2);
    expect(cards[0].querySelector('[data-testid="watcher-backend-badge"]')?.textContent).toBe('Chrome');
    expect(cards[0].querySelector('[data-testid="watcher-action-badge"]')?.textContent).toBe('draft_and_fill');
    expect(cards[1].querySelector('[data-testid="watcher-backend-badge"]')?.textContent).toBe('scraper_fs');
    expect(cards[1].querySelector('[data-testid="watcher-rule-status"]')?.textContent).toContain(
      'Paused: HUMAN_ACTION_REQUIRED',
    );
    expect(cards[1].querySelector('[data-testid="watcher-resume-btn"]')).not.toBeNull();

    const secretInput = root.querySelector<HTMLInputElement>('[data-testid="notif-webhook-secret"]');
    const tokenInput = root.querySelector<HTMLInputElement>('[data-testid="notif-telegram-token"]');
    expect(secretInput?.placeholder).toBe('Configured (leave blank to keep)');
    expect(tokenInput?.placeholder).toBe('Configured (leave blank to keep)');

    panel.destroy();
  });

  it('creates a rule switching between chrome and scraper_fs and shows availability warning', async () => {
    const rules: WatchRule[] = [];
    let createdPayload: Record<string, unknown> | null = null;

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/watchers/status') {
        return new Response(JSON.stringify(makeStatus({ active_rules: rules.length })), { status: 200 });
      }
      if (url === '/api/watchers' && init?.method === 'POST') {
        createdPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        const newRule = makeRule({
          id: 10,
          name: String(createdPayload.name),
          discovery_backend: createdPayload.discovery_backend as 'chrome' | 'scraper_fs',
          action_mode: createdPayload.action_mode as 'alert_only',
        });
        rules.push(newRule);
        return new Response(JSON.stringify({ rule: newRule }), { status: 201 });
      }
      if (url === '/api/watchers') {
        return new Response(JSON.stringify({ rules }), { status: 200 });
      }
      if (url === '/api/notifications/config') {
        return new Response(JSON.stringify({ config: makeNotifConfig() }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const panel = new WatchersPanel(root, transport);
    await panel.init();

    root.querySelector<HTMLButtonElement>('[data-testid="new-watcher-btn"]')?.click();
    expect(root.querySelector('[data-testid="watcher-chrome-settings"]')?.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('[data-testid="watcher-scraper-fs-settings"]')?.hasAttribute('hidden')).toBe(true);

    // Safe defaults: disabled by default, draft_and_fill action mode, from_active_projects hint hidden
    const enabledCb = root.querySelector<HTMLInputElement>('[data-testid="watcher-form-enabled"]');
    const actionSelect = root.querySelector<HTMLSelectElement>('[data-testid="watcher-form-action-mode"]');
    const activeProjCb = root.querySelector<HTMLInputElement>(
      '[data-testid="watcher-form-from-active-projects"]',
    );
    const activeProjHint = root.querySelector<HTMLElement>(
      '[data-testid="watcher-from-active-projects-hint"]',
    );
    expect(enabledCb?.checked).toBe(false);
    expect(actionSelect?.value).toBe('draft_and_fill');
    expect(activeProjCb?.checked).toBe(false);
    expect(activeProjHint?.hidden).toBe(true);

    // Checking from_active_projects reveals the extra-queries warning hint
    if (activeProjCb) {
      activeProjCb.checked = true;
      activeProjCb.dispatchEvent(new Event('change', { bubbles: true }));
      expect(activeProjHint?.hidden).toBe(false);
      activeProjCb.checked = false;
      activeProjCb.dispatchEvent(new Event('change', { bubbles: true }));
      expect(activeProjHint?.hidden).toBe(true);
    }

    // Switch to scraper_fs
    const sfsRadio = root.querySelector<HTMLInputElement>('[data-testid="watcher-form-backend-scraper-fs"]');
    if (sfsRadio) {
      sfsRadio.checked = true;
      sfsRadio.dispatchEvent(new Event('change', { bubbles: true }));
    }

    expect(root.querySelector('[data-testid="watcher-chrome-settings"]')?.hasAttribute('hidden')).toBe(true);
    expect(root.querySelector('[data-testid="watcher-scraper-fs-settings"]')?.hasAttribute('hidden')).toBe(false);
    expect(root.querySelector('[data-testid="watcher-scraper-fs-warning"]')?.textContent).toContain(
      'FlareSolverr not reachable',
    );

    const jitterInput = root.querySelector<HTMLInputElement>('[data-testid="watcher-form-jitter"]');
    expect(jitterInput?.getAttribute('max')).toBe('0.9');

    const nameInput = root.querySelector<HTMLInputElement>('[data-testid="watcher-form-name"]');
    const queriesInput = root.querySelector<HTMLInputElement>('[data-testid="watcher-form-queries"]');
    const profileInput = root.querySelector<HTMLInputElement>('[data-testid="watcher-form-sfs-profile"]');
    const budgetMinInput = root.querySelector<HTMLInputElement>('[data-testid="watcher-form-budget-min"]');
    const budgetMaxInput = root.querySelector<HTMLInputElement>('[data-testid="watcher-form-budget-max"]');
    const minScoreInput = root.querySelector<HTMLInputElement>('[data-testid="watcher-form-min-score"]');
    if (nameInput) nameInput.value = 'ScraperFS Go Watch';
    if (queriesInput) queriesInput.value = 'golang, kubernetes';
    if (profileInput) profileInput.value = 'go-backend';
    if (budgetMinInput) budgetMinInput.value = '500';
    if (budgetMaxInput) budgetMaxInput.value = '2500';
    if (minScoreInput) minScoreInput.value = '74.6';

    root
      .querySelector<HTMLFormElement>('#watcher-rule-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(createdPayload).not.toBeNull());
    const payload = createdPayload as Record<string, unknown> | null;
    expect(payload?.name).toBe('ScraperFS Go Watch');
    expect(payload?.enabled).toBe(false);
    expect(payload?.action_mode).toBe('draft_and_fill');
    expect(payload?.discovery_backend).toBe('scraper_fs');
    expect(payload?.min_score).toBe(75);
    expect((payload?.discovery_config as Record<string, unknown>)?.queries).toEqual([
      'golang',
      'kubernetes',
    ]);
    expect((payload?.discovery_config as Record<string, unknown>)?.budget_min).toBe(500);
    expect((payload?.discovery_config as Record<string, unknown>)?.budget_max).toBe(2500);
    expect((payload?.discovery_config as Record<string, unknown>)?.scraper_fs_profile).toBe(
      'go-backend',
    );

    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-testid="watcher-rule-card"]').length).toBe(1),
    );
    panel.destroy();
  });

  it('toggles, dry-runs, resumes, edits, inspects runs/events, and deletes a rule', async () => {
    let rules = [makeRule({ id: 5, paused_reason: 'COOLDOWN', enabled: true })];
    const calls: string[] = [];

    const runs: WatchRun[] = [
      {
        id: 101,
        watch_rule_id: 5,
        discovery_backend: 'chrome',
        triggered_by: 'manual',
        status: 'completed',
        scraped_count: 12,
        new_jobs_count: 4,
        qualified_count: 2,
        drafted_count: 1,
        filled_count: 0,
        submitted_count: 0,
        alerted_count: 1,
        started_at: '2026-11-22T10:00:00Z',
        created_at: '2026-11-22T10:00:00Z',
      },
    ];
    const events: WatchEvent[] = [
      {
        id: 201,
        watch_rule_id: 5,
        watch_run_id: 101,
        job_id: 88,
        job_title: 'Senior Go Engineer',
        upwork_job_id: '~01abc',
        stage: 'drafted',
        decision_reason: 'score 92 >= 70',
        confidence: 0.91,
        created_at: '2026-11-22T10:00:05Z',
        updated_at: '2026-11-22T10:00:05Z',
      },
    ];

    const transport: ApiTransport = vi.fn(async (url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url === '/api/watchers/status') {
        return new Response(JSON.stringify(makeStatus()), { status: 200 });
      }
      if (url === '/api/watchers') {
        return new Response(JSON.stringify({ rules }), { status: 200 });
      }
      if (url === '/api/notifications/config') {
        return new Response(JSON.stringify({ config: makeNotifConfig() }), { status: 200 });
      }
      if (url === '/api/watchers/5/toggle' && init?.method === 'POST') {
        rules = [makeRule({ id: 5, enabled: false, paused_reason: 'COOLDOWN' })];
        return new Response(JSON.stringify({ rule: rules[0] }), { status: 200 });
      }
      if (url === '/api/watchers/5/resume' && init?.method === 'POST') {
        rules = [makeRule({ id: 5, enabled: true, paused_reason: '' })];
        return new Response(JSON.stringify({ rule: rules[0] }), { status: 200 });
      }
      if (url === '/api/watchers/5/run' && init?.method === 'POST') {
        return new Response(JSON.stringify({ run: runs[0], events }), { status: 200 });
      }
      if (url === '/api/watchers/5' && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Partial<WatchRule>;
        rules = [makeRule({ id: 5, name: body.name ?? 'Updated', paused_reason: '' })];
        return new Response(JSON.stringify({ rule: rules[0] }), { status: 200 });
      }
      if (url === '/api/watchers/5/runs?limit=20&offset=0') {
        return new Response(JSON.stringify({ runs, total: 1 }), { status: 200 });
      }
      if (url === '/api/watchers/5/events?limit=50&offset=0') {
        return new Response(JSON.stringify({ events, total: 1 }), { status: 200 });
      }
      if (url === '/api/watchers/5' && init?.method === 'DELETE') {
        rules = [];
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const panel = new WatchersPanel(root, transport);
    await panel.init();

    // Toggle
    root.querySelector<HTMLButtonElement>('[data-testid="watcher-toggle-btn"]')?.click();
    await vi.waitFor(() => expect(calls).toContain('POST /api/watchers/5/toggle'));

    // Resume
    root.querySelector<HTMLButtonElement>('[data-testid="watcher-resume-btn"]')?.click();
    await vi.waitFor(() => expect(calls).toContain('POST /api/watchers/5/resume'));

    // Dry Run
    root.querySelector<HTMLButtonElement>('[data-testid="watcher-dry-run-btn"]')?.click();
    await vi.waitFor(() => expect(calls).toContain('POST /api/watchers/5/run'));

    // Inspect Runs & Events
    root.querySelector<HTMLButtonElement>('[data-testid="watcher-inspect-btn"]')?.click();
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="watcher-runs-list"]')?.textContent).toContain('scraped 12'),
    );
    expect(root.querySelector('[data-testid="watcher-events-list"]')?.textContent).toContain(
      'Senior Go Engineer',
    );
    expect(root.querySelector('[data-testid="watcher-events-list"]')?.textContent).toContain('drafted');

    // Edit
    root.querySelector<HTMLButtonElement>('[data-testid="watcher-edit-btn"]')?.click();
    const nameInput = root.querySelector<HTMLInputElement>('[data-testid="watcher-form-name"]');
    if (nameInput) nameInput.value = 'Renamed Rule';
    root
      .querySelector<HTMLFormElement>('#watcher-rule-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(calls).toContain('PATCH /api/watchers/5'));

    // Delete
    root.querySelector<HTMLButtonElement>('[data-testid="watcher-delete-btn"]')?.click();
    await vi.waitFor(() => expect(calls).toContain('DELETE /api/watchers/5'));
    await vi.waitFor(() =>
      expect(root.querySelectorAll('[data-testid="watcher-rule-card"]').length).toBe(0),
    );

    panel.destroy();
  });

  it('saves notification config preserving blank masked secrets and runs test notification', async () => {
    let savedNotifPayload: Record<string, unknown> | null = null;

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/watchers/status') {
        return new Response(JSON.stringify(makeStatus()), { status: 200 });
      }
      if (url === '/api/watchers') {
        return new Response(JSON.stringify({ rules: [] }), { status: 200 });
      }
      if (url === '/api/notifications/config' && init?.method === 'PUT') {
        savedNotifPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ config: makeNotifConfig() }), { status: 200 });
      }
      if (url === '/api/notifications/config') {
        return new Response(JSON.stringify({ config: makeNotifConfig() }), { status: 200 });
      }
      if (url === '/api/notifications/test' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            ok: true,
            results: {
              chrome: { ok: true },
              webhook: { sent: true },
              telegram: { ok: false, error: 'bad chat' },
            },
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const panel = new WatchersPanel(root, transport);
    await panel.init();

    // Leave webhook_secret & telegram_bot_token blank -> should NOT be included in PUT payload
    root
      .querySelector<HTMLFormElement>('#watcher-notif-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(savedNotifPayload).not.toBeNull());
    const notifPayload = savedNotifPayload as Record<string, unknown> | null;
    expect(notifPayload?.webhook_secret).toBeUndefined();
    expect(notifPayload?.telegram_bot_token).toBeUndefined();
    expect(notifPayload?.notify_events).toEqual(['hot_job_alert', 'pending_approval']);

    // Test notification
    root.querySelector<HTMLButtonElement>('[data-testid="notif-test-btn"]')?.click();
    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="notif-test-result"]')?.textContent).toContain(
        'Test succeeded',
      ),
    );
    const resultText = root.querySelector('[data-testid="notif-test-result"]')?.textContent ?? '';
    expect(resultText).toContain('chrome: sent');
    expect(resultText).toContain('webhook: sent');
    expect(resultText).toContain('telegram: failed (bad chat)');

    panel.destroy();
  });

  it('mounts inside DashboardController when Watchers topbar button is clicked', async () => {
    document.body.innerHTML = '<div id="dash-root"></div>';
    const dashRoot = document.getElementById('dash-root') as HTMLElement;

    const transport: ApiTransport = vi.fn(async (url) => {
      if (url === '/api/watchers/status') {
        return new Response(JSON.stringify(makeStatus({ active_rules: 2, paused_rules: 1 })), {
          status: 200,
        });
      }
      if (url === '/api/watchers') {
        return new Response(JSON.stringify({ rules: [makeRule()] }), { status: 200 });
      }
      if (url === '/api/notifications/config') {
        return new Response(JSON.stringify({ config: makeNotifConfig() }), { status: 200 });
      }
      if (url === '/api/enrichment-config') {
        return new Response(
          JSON.stringify({
            max_batch_size: 25,
            default_mode: 'full',
            default_force: false,
            skip_detail_if_present: true,
            require_details: false,
            max_concurrency: 2,
            default_model: '',
            default_effort: '',
            confirm_threshold: 5,
            wait_timeout_seconds: 60,
            web_ui_enabled: true,
            web_session_ttl_minutes: 720,
          }),
          { status: 200 },
        );
      }
      if (url.startsWith('/api/active-projects')) {
        return new Response(JSON.stringify({ projects: [], count: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/jobs?')) {
        return new Response(JSON.stringify({ jobs: [], total: 0 }), { status: 200 });
      }
      if (url.startsWith('/api/enrichment-batches')) {
        return new Response(JSON.stringify({ batches: [], total: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const controller = new DashboardController({
      root: dashRoot,
      transport,
      surface: 'web',
    });
    await controller.init();

    expect(dashRoot.querySelector('[data-testid="watchers-status-badge"]')?.textContent).toBe(
      '2 (1 paused)',
    );
    const panelEl = dashRoot.querySelector<HTMLElement>('[data-testid="watchers-panel"]');
    expect(panelEl?.hasAttribute('hidden')).toBe(true);

    dashRoot.querySelector<HTMLButtonElement>('[data-testid="toggle-watchers-panel-btn"]')?.click();
    expect(panelEl?.hasAttribute('hidden')).toBe(false);

    await vi.waitFor(() =>
      expect(dashRoot.querySelectorAll('[data-testid="watcher-rule-card"]').length).toBe(1),
    );

    controller.destroy();
  });

  it('shows running state during manual runs, clarifies seeded baseline, and flags active-project extra queries on cards', async () => {
    const deferred: { resolve?: (res: Response) => void } = {};
    const rule = makeRule({
      id: 7,
      name: 'WordPress Watcher',
      discovery_config: {
        source: 'search',
        queries: ['wordpress'],
        from_active_projects: true,
      },
    });

    const transport: ApiTransport = vi.fn((url, init) => {
      if (url === '/api/watchers/status') {
        return Promise.resolve(new Response(JSON.stringify(makeStatus()), { status: 200 }));
      }
      if (url === '/api/watchers') {
        return Promise.resolve(new Response(JSON.stringify({ rules: [rule] }), { status: 200 }));
      }
      if (url === '/api/notifications/config') {
        return Promise.resolve(
          new Response(JSON.stringify({ config: makeNotifConfig() }), { status: 200 }),
        );
      }
      if (url === '/api/watchers/7/run' && init?.method === 'POST') {
        return new Promise<Response>((resolve) => {
          deferred.resolve = resolve;
        });
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });

    const panel = new WatchersPanel(root, transport);
    await panel.init();

    // Card explicitly calls out active project extra queries
    expect(root.querySelector('[data-testid="watcher-rule-card"]')?.textContent).toContain(
      'wordpress (+ active project tech stacks)',
    );

    // Click Run Now -> enters Running... state with disabled action buttons
    root.querySelector<HTMLButtonElement>('[data-testid="watcher-run-btn"]')?.click();
    await vi.waitFor(() => {
      const btn = root.querySelector<HTMLButtonElement>('[data-testid="watcher-run-btn"]');
      expect(btn?.disabled).toBe(true);
      expect(btn?.textContent?.trim()).toBe('Running...');
    });
    expect(root.querySelector('[data-testid="watchers-banner"]')?.textContent).toContain(
      'Running watcher for "WordPress Watcher"...',
    );

    // Resolve with seeded status
    deferred.resolve?.(
      new Response(
        JSON.stringify({
          run: {
            id: 2,
            watch_rule_id: 7,
            discovery_backend: 'chrome',
            triggered_by: 'manual',
            status: 'seeded',
            scraped_count: 59,
            new_jobs_count: 0,
            qualified_count: 0,
            drafted_count: 0,
            filled_count: 0,
            submitted_count: 0,
            alerted_count: 0,
            started_at: '2026-11-22T10:00:00Z',
            created_at: '2026-11-22T10:00:00Z',
          },
          events: [],
        }),
        { status: 200 },
      ),
    );

    await vi.waitFor(() => {
      expect(root.querySelector('[data-testid="watchers-banner"]')?.textContent).toContain(
        'baseline seeded',
      );
      expect(root.querySelector<HTMLButtonElement>('[data-testid="watcher-run-btn"]')?.disabled).toBe(
        false,
      );
    });

    panel.destroy();
  });

  it('detects and auto-saves Telegram chat ID via Detect Chat ID button', async () => {
    let config = makeNotifConfig({ telegram_enabled: true, telegram_chat_id: '' });

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/watchers/status') {
        return new Response(JSON.stringify(makeStatus()), { status: 200 });
      }
      if (url === '/api/watchers') {
        return new Response(JSON.stringify({ rules: [] }), { status: 200 });
      }
      if (url === '/api/notifications/config') {
        return new Response(JSON.stringify({ config }), { status: 200 });
      }
      if (url === '/api/notifications/telegram/detect-chat' && init?.method === 'POST') {
        config = makeNotifConfig({ telegram_enabled: true, telegram_chat_id: '777888999' });
        return new Response(
          JSON.stringify({
            bot_username: 'UpworkWatchBot',
            chats: [
              {
                chat_id: '777888999',
                type: 'private',
                display_name: 'Maxx (@maxx) [private]',
                last_text: '/start',
              },
            ],
            saved: true,
            selected_chat_id: '777888999',
            config,
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const panel = new WatchersPanel(root, transport);
    await panel.init();

    root.querySelector<HTMLButtonElement>('[data-testid="notif-telegram-detect-btn"]')?.click();
    await vi.waitFor(() => {
      const chatInput = root.querySelector<HTMLInputElement>('[data-testid="notif-telegram-chat-id"]');
      expect(chatInput?.value).toBe('777888999');
    });
    expect(root.querySelector('[data-testid="watchers-banner"]')?.textContent).toContain(
      'Detected and saved Telegram chat: Maxx (@maxx) [private] (ID: 777888999)',
    );

    panel.destroy();
  });

  it('defaults new rules to max_pages=3 and per_page=20, renders custom pagination on cards, and preserves unexposed discovery_config fields on edit', async () => {
    const rules: WatchRule[] = [];
    let createdPayload: Record<string, unknown> | null = null;
    let updatedPayload: Record<string, unknown> | null = null;

    const transport: ApiTransport = vi.fn(async (url, init) => {
      if (url === '/api/watchers/status') {
        return new Response(JSON.stringify(makeStatus({ active_rules: rules.length })), {
          status: 200,
        });
      }
      if (url === '/api/watchers' && init?.method === 'POST') {
        createdPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        const dc = (createdPayload.discovery_config ?? {}) as Record<string, unknown>;
        const createdRule = makeRule({
          id: 12,
          name: String(createdPayload.name),
          discovery_config: {
            ...dc,
            sort: 'recency',
            proposal_tiers: ['0_4'],
          },
        });
        rules.push(createdRule);
        return new Response(JSON.stringify({ rule: createdRule }), { status: 201 });
      }
      if (url === '/api/watchers/12' && init?.method === 'PATCH') {
        updatedPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
        const dc = (updatedPayload.discovery_config ?? {}) as Record<string, unknown>;
        rules[0] = makeRule({
          id: 12,
          name: String(updatedPayload.name),
          discovery_config: dc,
        });
        return new Response(JSON.stringify({ rule: rules[0] }), { status: 200 });
      }
      if (url === '/api/watchers') {
        return new Response(JSON.stringify({ rules }), { status: 200 });
      }
      if (url === '/api/notifications/config') {
        return new Response(JSON.stringify({ config: makeNotifConfig() }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const panel = new WatchersPanel(root, transport);
    await panel.init();

    // 1. New rule form defaults to max_pages=3 and per_page=20
    root.querySelector<HTMLButtonElement>('[data-testid="new-watcher-btn"]')?.click();
    const maxPagesInput = root.querySelector<HTMLInputElement>(
      '[data-testid="watcher-form-max-pages"]',
    );
    const perPageSelect = root.querySelector<HTMLSelectElement>(
      '[data-testid="watcher-form-per-page"]',
    );
    expect(maxPagesInput?.value).toBe('3');
    expect(perPageSelect?.value).toBe('20');

    // 2. Submit custom max_pages=5 and per_page=50
    const nameInput = root.querySelector<HTMLInputElement>('[data-testid="watcher-form-name"]');
    if (nameInput) nameInput.value = 'Paginated Go Watch';
    if (maxPagesInput) maxPagesInput.value = '5';
    if (perPageSelect) perPageSelect.value = '50';

    root
      .querySelector<HTMLFormElement>('#watcher-rule-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(createdPayload).not.toBeNull());
    const created = createdPayload as Record<string, unknown> | null;
    expect((created?.discovery_config as Record<string, unknown>)?.max_pages).toBe(5);
    expect((created?.discovery_config as Record<string, unknown>)?.per_page).toBe(50);

    await vi.waitFor(() =>
      expect(root.querySelector('[data-testid="watcher-rule-card"]')?.textContent).toContain(
        'Pages: 5 (50/page)',
      ),
    );

    // 3. Edit rule: loads 5 and 50, preserves unexposed sort/proposal_tiers on save
    root.querySelector<HTMLButtonElement>('[data-testid="watcher-edit-btn"]')?.click();
    const editMaxPages = root.querySelector<HTMLInputElement>(
      '[data-testid="watcher-form-max-pages"]',
    );
    const editPerPage = root.querySelector<HTMLSelectElement>(
      '[data-testid="watcher-form-per-page"]',
    );
    expect(editMaxPages?.value).toBe('5');
    expect(editPerPage?.value).toBe('50');

    root
      .querySelector<HTMLFormElement>('#watcher-rule-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(updatedPayload).not.toBeNull());
    const updated = updatedPayload as Record<string, unknown> | null;
    expect(updated?.discovery_config).toMatchObject({
      max_pages: 5,
      per_page: 50,
      sort: 'recency',
      proposal_tiers: ['0_4'],
    });

    panel.destroy();
  });
});
