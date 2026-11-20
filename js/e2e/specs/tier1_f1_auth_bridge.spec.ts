import { parseMcpToolJson } from '../helpers/mcp-client.ts';
import { getSessionStatus, waitForExtensionConnected } from '../helpers/pairing.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

test.describe('Tier 1 F1 — Extension Shell, Auth, WS Bridge & Session Health', () => {
  test('T1-F1-01: unauthenticated /health liveness and Bearer-authenticated /api/jobs access', async ({
    daemon,
  }) => {
    const healthRes = await fetch(`${daemon.baseUrl}/health`);
    expect(healthRes.status).toBe(200);
    const healthBody = (await healthRes.json()) as { status: string; db?: string };
    expect(healthBody.status).toBe('ok');
    expect(healthBody.db).toBe('up');

    const jobsRes = await daemon.apiFetch('/api/jobs');
    expect(jobsRes.status).toBe(200);
    const rawBody = await jobsRes.text();
    const parsed = JSON.parse(rawBody) as { jobs: unknown[] };
    expect(Array.isArray(parsed.jobs)).toBe(true);

    expect(rawBody).not.toContain(daemon.apiToken);
    const serializedHeaders = JSON.stringify(Object.fromEntries(jobsRes.headers.entries()));
    expect(serializedHeaders).not.toContain(daemon.apiToken);
  });

  test('T1-F1-02: Options page pairing & loopback WebSocket first-frame auth handshake', async ({
    extensionCtx,
    daemon,
    extPages,
  }) => {
    const optionsPage = await extPages.openOptions();
    try {
      const urlInput = optionsPage
        .locator(
          '[data-testid="daemon-url-input"], input[name="daemonUrl"], input[name="apiBaseUrl"], input[type="url"]',
        )
        .or(optionsPage.getByLabel(/daemon.*url|api.*url|server.*url/i))
        .first();
      await urlInput.fill(daemon.baseUrl);

      const tokenInput = optionsPage
        .locator(
          '[data-testid="api-token-input"], input[name="apiToken"], input[name="token"], input[type="password"]',
        )
        .or(optionsPage.getByLabel(/token|bearer/i))
        .first();
      await tokenInput.fill(daemon.apiToken);

      const explicitSaveBtn = optionsPage.locator('[data-testid="save-options-btn"]');
      const saveBtn =
        (await explicitSaveBtn.count()) > 0
          ? explicitSaveBtn.first()
          : optionsPage.getByRole('button', { name: /save|pair/i }).first();
      await saveBtn.click();

      const status = await waitForExtensionConnected(daemon, true, 15_000);
      expect(status.extension_connected).toBe(true);
      expect(typeof status.session_id).toBe('string');
      expect((status.session_id ?? '').length).toBeGreaterThan(0);
      expect(status.browser).toBe('chrome');

      const uiStatus = optionsPage
        .locator('[data-testid="connection-status"], [data-testid="options-status"]')
        .or(optionsPage.getByText(/connected|paired|saved/i))
        .first();
      await expect(uiStatus).toBeVisible({ timeout: 10_000 });
    } finally {
      await optionsPage.close();
    }

    expect(extensionCtx.errors).toEqual([]);
  });

  test('T1-F1-03: WebSocket 20s heartbeat keepalive and session.status RPC round-trip', async ({
    pairedExtension,
    daemon,
    mcpHttp,
    upworkPage,
  }) => {
    await upworkPage.goto('https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1', {
      waitUntil: 'domcontentloaded',
    });

    const initialStatus = await getSessionStatus(daemon);
    expect(initialStatus.extension_connected).toBe(true);

    const rpcResult = await mcpHttp.callTool('upwork_session_status', {});
    expect(rpcResult.isError).not.toBe(true);
    const rpcPayload = parseMcpToolJson<{
      extension_connected: boolean;
      upwork_logged_in?: boolean;
      logged_in?: boolean;
      policy_mode?: string;
    }>(rpcResult);
    expect(rpcPayload.extension_connected).toBe(true);
    expect(rpcPayload.upwork_logged_in ?? rpcPayload.logged_in).toBe(true);
    expect(rpcPayload.policy_mode).toBe('confirm_in_ui');

    // Wait past one 20s WS ping/pong heartbeat interval and verify connection stays open.
    await new Promise((resolve) => setTimeout(resolve, 21_500));

    const afterHeartbeat = await getSessionStatus(daemon);
    expect(afterHeartbeat.extension_connected).toBe(true);
    if (initialStatus.last_heartbeat_at && afterHeartbeat.last_heartbeat_at) {
      expect(Date.parse(afterHeartbeat.last_heartbeat_at)).toBeGreaterThan(
        Date.parse(initialStatus.last_heartbeat_at),
      );
    }
    expect(pairedExtension.errors).toEqual([]);
  });

  test('T1-F1-04: Shadow DOM mini-toolbar isolation & Background API proxy without CSP errors', async ({
    pairedExtension,
    daemon,
    extPages,
    upworkPage,
  }) => {
    const directDaemonRequests: string[] = [];
    upworkPage.on('request', (req) => {
      if (req.url().startsWith(daemon.baseUrl)) {
        directDaemonRequests.push(req.url());
      }
    });

    await upworkPage.goto('https://www.upwork.com/jobs/~022115332344639171/', {
      waitUntil: 'domcontentloaded',
    });

    // Inject hostile global CSS to verify Shadow DOM encapsulation protects toolbar button styling.
    await upworkPage.addStyleTag({
      content:
        'button { background: rgb(255, 0, 0) !important; color: rgb(255, 255, 0) !important; }',
    });

    const toolbarHost = extPages.getShadowToolbar(upworkPage);
    await expect(toolbarHost).toBeAttached({ timeout: 15_000 });

    const shadowInfo = await toolbarHost.evaluate((el) => {
      const root = el.shadowRoot;
      if (!root) {
        return { hasShadow: false, btnBg: '' };
      }
      const btn = root.querySelector('button');
      const btnBg = btn ? getComputedStyle(btn).backgroundColor : '';
      return { hasShadow: true, btnBg };
    });
    expect(shadowInfo.hasShadow).toBe(true);
    expect(shadowInfo.btnBg).not.toBe('rgb(255, 0, 0)');

    const analyzeBtn = toolbarHost
      .locator('[data-testid="toolbar-analyze-btn"], [data-testid="toolbar-save-btn"], button')
      .first();
    await analyzeBtn.click();

    await expect
      .poll(
        async () => {
          const res = await daemon.apiFetch('/api/jobs');
          if (!res.ok) return 0;
          const body = (await res.json()) as { jobs: Array<{ upwork_job_id?: string }> };
          return body.jobs.filter((j) => j.upwork_job_id === '~022115332344639171').length;
        },
        { timeout: 15_000 },
      )
      .toBe(1);

    expect(directDaemonRequests).toEqual([]);
    expect(pairedExtension.errors).toEqual([]);
  });

  test('T1-F1-05: Extension Popup status display & Side Panel navigation tabs', async ({
    pairedExtension,
    daemon,
    extPages,
  }) => {
    const saveJobRes = await daemon.apiFetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_title: 'Popup Pending Approval Test Job',
        job_description: 'Test job for pending approval badge verification.',
        url: 'https://www.upwork.com/jobs/~022115332344639171/',
      }),
    });
    expect(saveJobRes.ok).toBe(true);
    const savedJob = (await saveJobRes.json()) as { id: number };

    const createProposalRes = await daemon.apiFetch('/api/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        job_id: savedJob.id,
        cover_letter: 'Ready for UI review.',
        bid_type: 'fixed',
        bid_amount: 1400,
        status: 'pending_approval',
      }),
    });
    expect(createProposalRes.ok).toBe(true);

    const popupPage = await extPages.openPopup();
    try {
      await expect(
        popupPage
          .locator('[data-testid="daemon-status"]')
          .or(popupPage.getByText(/connected/i))
          .first(),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        popupPage
          .locator('[data-testid="policy-mode"]')
          .or(popupPage.getByText(/confirm_in_ui/i))
          .first(),
      ).toBeVisible();
      await expect(
        popupPage
          .locator('[data-testid="pending-approvals-count"]')
          .or(popupPage.getByText(/1/))
          .first(),
      ).toBeVisible();
    } finally {
      await popupPage.close();
    }

    const sidePanelPage = await extPages.openSidePanel();
    try {
      const expectedTabs = [
        /pipeline|jobs/i,
        /approvals?/i,
        /messages?|inbox/i,
        /activity|policy/i,
        /profile|blueprints?/i,
        /selector/i,
      ];
      for (const tabRegex of expectedTabs) {
        await expect(
          sidePanelPage
            .getByRole('tab', { name: tabRegex })
            .or(sidePanelPage.getByRole('button', { name: tabRegex }))
            .first(),
        ).toBeVisible({ timeout: 10_000 });
      }
    } finally {
      await sidePanelPage.close();
    }

    expect(pairedExtension.errors).toEqual([]);
  });

  test('T1-F1-06: Passive GraphQL tap (world: MAIN) observation & tabs.list RPC', async ({
    pairedExtension,
    mockClient,
    mcpHttp,
    upworkPage,
  }) => {
    await upworkPage.goto('https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1', {
      waitUntil: 'domcontentloaded',
    });

    // Trigger a natural page-origin GraphQL XHR/fetch observed passively by passive-tap.content.ts
    await upworkPage.evaluate(async () => {
      await fetch('https://www.upwork.com/api/graphql/jobs-search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ variables: { query: 'WordPress' } }),
      });
    });

    const detailPage = await pairedExtension.context.newPage();
    try {
      await detailPage.goto('https://www.upwork.com/jobs/~022115332344639171/', {
        waitUntil: 'domcontentloaded',
      });

      const gqlRequests = await mockClient.getRequests('/api/graphql');
      expect(gqlRequests.length).toBe(1);

      const tabsRes = await mcpHttp.callTool('upwork_list_tabs', {});
      expect(tabsRes.isError).not.toBe(true);
      const parsed = parseMcpToolJson<{
        tabs: Array<{
          id: number;
          title: string;
          url: string;
          active: boolean;
          automation: boolean;
        }>;
      }>(tabsRes);
      expect(Array.isArray(parsed.tabs)).toBe(true);
      const urls = parsed.tabs.map((t) => t.url);
      expect(urls.some((u) => u.includes('/nx/search/jobs/'))).toBe(true);
      expect(urls.some((u) => u.includes('~022115332344639171'))).toBe(true);
      for (const tab of parsed.tabs) {
        expect(typeof tab.id).toBe('number');
        expect(typeof tab.title).toBe('string');
        expect(typeof tab.active).toBe('boolean');
        expect(typeof tab.automation).toBe('boolean');
      }
    } finally {
      await detailPage.close();
    }
  });
});
