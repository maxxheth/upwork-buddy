import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('Standalone Web Auth Shell (js/web/main.ts)', () => {
  beforeEach(() => {
    vi.resetModules();
    window.sessionStorage.clear();
    window.localStorage.clear();
    document.body.innerHTML = '<div id="web-auth-root"></div><main id="dashboard-root"></main>';
    window.history.replaceState(null, '', '/dashboard/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, '', '/');
  });

  it('does not clobber unlock gate user typing when concurrent init() requests return 401', async () => {
    window.sessionStorage.setItem('upwork_buddy_web_session_token', 'stale-session-token');

    let resolveSecond401!: (res: Response) => void;
    let firstInitCallsCompleted = false;

    vi.spyOn(window, 'fetch').mockImplementation(async (input) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      // Pre-mount validateToken() passes so mountDashboard() runs
      if (!firstInitCallsCompleted && (url === '/api/health' || url === '/api/enrichment-config')) {
        if (url === '/api/enrichment-config') {
          firstInitCallsCompleted = true;
        }
        return new Response(
          JSON.stringify({
            ok: true,
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

      if (url === '/api/enrichment-config') {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      if (url.startsWith('/api/active-projects')) {
        return new Promise<Response>((res) => {
          resolveSecond401 = res;
        });
      }
      if (url.startsWith('/api/search-runs')) {
        return new Response(JSON.stringify({ search_runs: [], total: 0 }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await import('../../web/main');
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Wait for first 401 to mount unlock gate
    const tokenInput = await vi.waitFor(() => {
      const el = document.querySelector<HTMLInputElement>('[data-testid="web-token-input"]');
      expect(el).not.toBeNull();
      return el as HTMLInputElement;
    });

    // User types into unlock input before second concurrent 401 resolves
    tokenInput.value = 'user-typing-token';

    resolveSecond401(new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }));
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 10));

    const afterInput = document.querySelector<HTMLInputElement>('[data-testid="web-token-input"]');
    expect(afterInput).toBe(tokenInput);
    expect(afterInput?.value).toBe('user-typing-token');
  });
});
