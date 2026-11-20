import { describe, expect, it } from 'vitest';
import { detectChallengeOrAuth } from './guards';
import { parseHtmlDocument } from './selector-engine';

describe('Content Guards (detectChallengeOrAuth)', () => {
  it('ignores 2fa/login tokens in query params or /jobs/ slugs while halting on real auth paths', () => {
    const doc = parseHtmlDocument(
      '<html><body><nav data-test="nav-user-menu"></nav><main>Job details</main></body></html>',
    );

    expect(
      detectChallengeOrAuth(doc, {
        href: 'https://www.upwork.com/jobs/Implement-2FA-in-React_~0123456789abcdef/?referrer_url_path=/ab/account-security/login',
        pathname: '/jobs/Implement-2FA-in-React_~0123456789abcdef/',
      }).challengeDetected,
    ).toBe(false);

    expect(
      detectChallengeOrAuth(doc, {
        href: 'https://www.upwork.com/nx/search/jobs/?q=2fa&page=1',
        pathname: '/nx/search/jobs/',
      }).challengeDetected,
    ).toBe(false);

    expect(
      detectChallengeOrAuth(doc, {
        href: 'https://www.upwork.com/ab/account-security/two-factor',
        pathname: '/ab/account-security/two-factor',
      }),
    ).toMatchObject({ challengeDetected: true, challengeType: 'two_factor' });

    expect(
      detectChallengeOrAuth(doc, {
        href: 'https://www.upwork.com/ab/account-security/login',
        pathname: '/ab/account-security/login',
      }),
    ).toMatchObject({ challengeDetected: true, challengeType: 'login' });

    expect(
      detectChallengeOrAuth(doc, {
        href: 'https://www.upwork.com/cdn-cgi/challenge-platform/h/b',
        pathname: '/cdn-cgi/challenge-platform/h/b',
      }),
    ).toMatchObject({ challengeDetected: true, challengeType: 'cloudflare' });
  });

  it('does not falsely flag logged-in Upwork content pages containing challenge phrases in headings or body while still flagging unauthenticated or selector-matched challenges', () => {
    const loggedInJobDoc = parseHtmlDocument(
      `<html><body>
        <nav data-test="nav-user-menu">Alex</nav>
        <main>
          <h1>Senior Auth Engineer — Two-Step Verification &amp; Security Check</h1>
          <p>Build automated monitoring for unusual activity and enter verification code flows.</p>
        </main>
      </body></html>`,
    );

    expect(
      detectChallengeOrAuth(loggedInJobDoc, {
        href: 'https://www.upwork.com/jobs/Senior-Auth-Engineer_~022115332344639171/',
        pathname: '/jobs/Senior-Auth-Engineer_~022115332344639171/',
      }),
    ).toMatchObject({ loggedIn: true, challengeDetected: false });

    const loggedOutChallengeDoc = parseHtmlDocument(
      `<html><body>
        <main>
          <h1>Verify you are human</h1>
          <p>Checking your browser before accessing Upwork.</p>
        </main>
      </body></html>`,
    );
    expect(
      detectChallengeOrAuth(loggedOutChallengeDoc, {
        href: 'https://www.upwork.com/jobs/~022115332344639171/',
        pathname: '/jobs/~022115332344639171/',
      }),
    ).toMatchObject({ loggedIn: false, challengeDetected: true });

    const inlineIframeChallengeDoc = parseHtmlDocument(
      `<html><body>
        <nav data-test="nav-user-menu">Alex</nav>
        <main>
          <iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b"></iframe>
        </main>
      </body></html>`,
    );
    expect(
      detectChallengeOrAuth(inlineIframeChallengeDoc, {
        href: 'https://www.upwork.com/jobs/~022115332344639171/',
        pathname: '/jobs/~022115332344639171/',
      }),
    ).toMatchObject({ loggedIn: false, challengeDetected: true, challengeType: 'cloudflare' });
  });
});
