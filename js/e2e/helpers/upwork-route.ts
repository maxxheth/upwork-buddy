import type { BrowserContext, Route } from '@playwright/test';

export interface UpworkProxyHandle {
  readonly blockedExternalUrls: string[];
  clearBlocked(): void;
}

const ALLOWED_LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

function isAllowedNonUpworkUrl(rawUrl: string): boolean {
  if (
    rawUrl.startsWith('chrome-extension://') ||
    rawUrl.startsWith('moz-extension://') ||
    rawUrl.startsWith('data:') ||
    rawUrl.startsWith('blob:') ||
    rawUrl.startsWith('about:')
  ) {
    return true;
  }
  try {
    const parsed = new URL(rawUrl);
    if (
      (parsed.protocol === 'http:' ||
        parsed.protocol === 'https:' ||
        parsed.protocol === 'ws:' ||
        parsed.protocol === 'wss:') &&
      ALLOWED_LOCAL_HOSTS.has(parsed.hostname)
    ) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export async function installUpworkMockProxy(
  context: BrowserContext,
  mockBaseUrl: string,
): Promise<UpworkProxyHandle> {
  const normalizedMockBase = mockBaseUrl.replace(/\/$/, '');
  const blockedExternalUrls: string[] = [];

  // Register catch-all FIRST because Playwright evaluates context.route handlers in LIFO order.
  await context.route('**/*', async (route: Route) => {
    const reqUrl = route.request().url();
    if (isAllowedNonUpworkUrl(reqUrl)) {
      await route.continue();
      return;
    }
    blockedExternalUrls.push(reqUrl);
    await route.abort('blockedbyclient');
  });

  // Register https://www.upwork.com/** SECOND so it takes precedence over **/*.
  await context.route('https://www.upwork.com/**', async (route: Route) => {
    const req = route.request();
    const incomingUrl = new URL(req.url());
    const targetUrl = `${normalizedMockBase}${incomingUrl.pathname}${incomingUrl.search}`;

    const forwardHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers())) {
      const lower = k.toLowerCase();
      if (
        lower === 'host' ||
        lower === 'content-length' ||
        lower === 'accept-encoding' ||
        lower === 'connection'
      ) {
        continue;
      }
      forwardHeaders[k] = v;
    }
    forwardHeaders['x-mock-original-url'] = req.url();

    const method = req.method();
    const rawBody =
      method === 'GET' || method === 'HEAD' ? undefined : (req.postDataBuffer() ?? undefined);
    const bodyInit = rawBody ? new Uint8Array(rawBody) : undefined;

    const res = await fetch(targetUrl, {
      method,
      headers: forwardHeaders,
      body: bodyInit,
      redirect: 'manual',
    });

    const locationHeader = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && locationHeader) {
      const resolvedLocation = new URL(locationHeader, 'https://www.upwork.com').toString();
      if (req.isNavigationRequest()) {
        // Fulfilling a navigation with HTTP 302 via CDP Fetch.fulfillRequest can bypass
        // Playwright route interception in Chromium; use an immediate client redirect instead
        // so the browser transitions cleanly to the redirected https://www.upwork.com/* URL
        // through this same context.route proxy.
        const html = `<!DOCTYPE html><html><head><meta charset="utf-8" /><script>window.location.replace(${JSON.stringify(resolvedLocation)});</script></head><body></body></html>`;
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: html,
        });
        return;
      }

      const redirectUrl = new URL(resolvedLocation);
      if (redirectUrl.hostname === 'www.upwork.com') {
        const hopped = await fetch(
          `${normalizedMockBase}${redirectUrl.pathname}${redirectUrl.search}`,
          { method: 'GET', headers: forwardHeaders, redirect: 'follow' },
        );
        const hopHeaders: Record<string, string> = {};
        hopped.headers.forEach((value, key) => {
          const lower = key.toLowerCase();
          if (
            lower === 'transfer-encoding' ||
            lower === 'content-encoding' ||
            lower === 'content-length'
          ) {
            return;
          }
          hopHeaders[key] = value;
        });
        const hopPayload = Buffer.from(await hopped.arrayBuffer());
        await route.fulfill({
          status: hopped.status,
          headers: hopHeaders,
          body: hopPayload,
        });
        return;
      }
    }

    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (
        lower === 'transfer-encoding' ||
        lower === 'content-encoding' ||
        lower === 'content-length'
      ) {
        return;
      }
      if (lower === 'location') {
        responseHeaders[key] = new URL(value, 'https://www.upwork.com').toString();
      } else {
        responseHeaders[key] = value;
      }
    });

    const payload = Buffer.from(await res.arrayBuffer());
    await route.fulfill({
      status: res.status,
      headers: responseHeaders,
      body: payload,
    });
  });

  // Also intercept off-origin Cloudflare challenge pages so post-send/submit redirects resolve deterministically
  await context.route('https://challenges.cloudflare.com/**', async (route: Route) => {
    const res = await fetch(`${normalizedMockBase}/cdn-cgi/challenge-platform`);
    const payload = Buffer.from(await res.arrayBuffer());
    await route.fulfill({
      status: res.status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: payload,
    });
  });

  return {
    blockedExternalUrls,
    clearBlocked(): void {
      blockedExternalUrls.length = 0;
    },
  };
}

export async function seedUpworkAuthCookies(context: BrowserContext): Promise<void> {
  await context.addCookies([
    {
      name: 'user_uid',
      value: 'e2e_freelancer_001',
      domain: 'www.upwork.com',
      path: '/',
      secure: true,
    },
    {
      name: 'oauth2_global_js_token',
      value: 'e2e_mock_oauth_token',
      domain: 'www.upwork.com',
      path: '/',
      secure: true,
    },
    {
      name: 'XSRF-TOKEN',
      value: 'e2e_xsrf_token',
      domain: 'www.upwork.com',
      path: '/',
      secure: true,
    },
  ]);
}

export async function clearUpworkAuthCookies(context: BrowserContext): Promise<void> {
  await context.clearCookies();
}
