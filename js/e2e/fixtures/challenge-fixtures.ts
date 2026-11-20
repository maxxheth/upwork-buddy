import type { AuthState } from '../server/mock-types.ts';

export function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderSharedAuthenticatedNav(authState: AuthState): string {
  if (authState !== 'authenticated') {
    return '';
  }
  return `<header data-cy="nav">
  <nav class="air3-nav-freelancer" aria-label="Primary">
    <a data-cy="brand" href="/nx/find-work/best-matches">Upwork</a>
    <div id="nav-right">
      <div class="air3-dropdown" data-test="nav-user-menu">
        <button type="button" aria-label="User menu">
          <img class="air3-avatar" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Maxx" />
          <span>Maxx Freelancer</span>
        </button>
      </div>
    </div>
  </nav>
</header>`;
}

export function renderLoginWallHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Log In - Upwork</title></head>
<body>
<main>
  <div class="air3-card" data-test="login-wall">
    <h1>Log in to Upwork</h1>
    <form id="login" action="/ab/account-security/login" method="post">
      <input id="login_username" name="login[username]" data-test="login-username" type="text" />
      <input id="login_password" name="login[password]" data-test="login-password" type="password" />
      <button id="login_control_continue" data-test="login-submit" type="submit">Continue</button>
    </form>
  </div>
</main>
</body>
</html>`;
}

export function renderTwoFactorHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Two-Step Verification - Upwork</title></head>
<body>
<main>
  <div class="air3-card" data-test="two-factor-challenge">
    <h1>Two-step verification</h1>
    <p>Enter the 6-digit verification code from your authenticator app.</p>
    <form id="two-factor-form">
      <input data-test="otp-input" name="deviceAuth[otp]" autocomplete="one-time-code" maxlength="6" />
      <button data-test="otp-submit" type="submit">Verify</button>
    </form>
  </div>
</main>
</body>
</html>`;
}

export function renderCaptchaChallengeHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Verify you are human | Upwork</title></head>
<body>
<main>
  <div id="challenge-form" class="cf-browser-verification" data-test="captcha-challenge">
    <h1>Verify you are human</h1>
    <p>Checking if the site connection is secure before continuing to www.upwork.com.</p>
    <div class="cf-turnstile" data-sitekey="mock-e2e-sitekey"></div>
    <iframe title="Widget containing a Cloudflare security challenge" src="about:blank"></iframe>
  </div>
</main>
</body>
</html>`;
}

export function renderCloudflareChallengeHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Just a moment... | Upwork</title></head>
<body>
<main>
  <div id="challenge-form" class="cf-browser-verification" data-test="captcha-challenge">
    <h1>Verify you are human</h1>
    <p>Just a moment... Checking if the site connection is secure before continuing to www.upwork.com.</p>
    <div class="cf-turnstile" data-sitekey="mock-e2e-sitekey"></div>
    <iframe title="Widget containing a Cloudflare security challenge" src="about:blank"></iframe>
  </div>
</main>
</body>
</html>`;
}

export function renderRateLimitHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>429 Too Many Requests | Upwork</title></head>
<body>
<main>
  <div data-test="rate-limit-error">
    <h1>Too Many Requests</h1>
    <p>Rate limit exceeded. Please retry later.</p>
  </div>
</main>
</body>
</html>`;
}
