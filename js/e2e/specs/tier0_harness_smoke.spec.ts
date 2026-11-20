import { expect, test } from '../helpers/test-fixtures.ts';
import { clearUpworkAuthCookies } from '../helpers/upwork-route.ts';

test.describe('Tier 0 — E2E Harness Smoke Suite @smoke', () => {
  test('SMOKE-01: Chromium MV3 loads extension & intercepts https://www.upwork.com/* via context.route @smoke', async ({
    extensionCtx,
    mockClient,
    upworkPage,
  }) => {
    expect(extensionCtx.extensionId.length).toBeGreaterThan(0);

    await upworkPage.goto('https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1', {
      waitUntil: 'domcontentloaded',
    });

    expect(new URL(upworkPage.url()).origin).toBe('https://www.upwork.com');
    await expect(upworkPage.locator('article.job-tile')).toHaveCount(4);

    const requests = await mockClient.getRequests('/nx/search/jobs/');
    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests[0].query.q).toBe('WordPress');

    const externalBlocked = await upworkPage.evaluate(async () => {
      try {
        await fetch('https://example.com/');
        return false;
      } catch {
        return true;
      }
    });
    expect(externalBlocked).toBe(true);
  });

  test('SMOKE-02: Content script injects into https://www.upwork.com/* & stays absent on non-Upwork origins @smoke', async ({
    extensionCtx,
    mockServer,
    upworkPage,
  }) => {
    await upworkPage.goto('https://www.upwork.com/jobs/~022115332344639171/', {
      waitUntil: 'domcontentloaded',
    });

    const toolbar = upworkPage.locator('#upwork-buddy-button-container, upwork-buddy-ui').first();
    await expect(toolbar).toBeAttached({ timeout: 15_000 });
    expect(extensionCtx.errors).toEqual([]);

    await upworkPage.goto(`${mockServer.baseUrl}/non-upwork`, {
      waitUntil: 'domcontentloaded',
    });

    await expect(upworkPage.locator('#upwork-buddy-button-container, upwork-buddy-ui')).toHaveCount(
      0,
    );
  });

  test('SMOKE-03: 302 redirect (redirect: manual) + cookie clear + mock control plane reset @smoke', async ({
    extensionCtx,
    mockClient,
    upworkPage,
  }) => {
    await mockClient.configure({ authState: 'logged_out' });
    await clearUpworkAuthCookies(extensionCtx.context);

    await upworkPage.goto('https://www.upwork.com/nx/find-work/best-matches', {
      waitUntil: 'domcontentloaded',
    });

    expect(upworkPage.url()).toBe('https://www.upwork.com/ab/account-security/login');
    await expect(upworkPage.locator('[data-test="login-wall"]')).toBeVisible();

    await mockClient.reset();
    const afterReset = await mockClient.getRequests();
    expect(afterReset).toEqual([]);
  });

  test('SMOKE-04: Live Go daemon /health on isolated Postgres 17 + Atlas migrations @smoke', async ({
    workerDb,
    daemon,
  }) => {
    expect(workerDb.config.port).not.toBe(5432);
    expect(workerDb.config.database).not.toBe('upwork_buddy');

    const res = await fetch(`${daemon.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db?: string };
    expect(['ok', 'up']).toContain(body.status);

    expect(daemon.getRedactedLogs()).not.toContain(daemon.apiToken);
  });
});
