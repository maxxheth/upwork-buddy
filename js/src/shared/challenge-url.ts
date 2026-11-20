import type { ChallengeType } from './protocol';
import { type AuthAndChallengeGuardsConfig, BUNDLED_SELECTORS } from './selectors';

export interface ChallengeUrlMatchResult {
  matched: boolean;
  challengeType: ChallengeType;
  matchedPattern?: string;
  category?: 'login' | 'challenge' | 'two_factor';
}

export function parseChallengeUrlParts(rawUrl: string): {
  hostAndPath: string;
  pathname: string;
} {
  try {
    const parsed = new URL(rawUrl, 'https://www.upwork.com');
    return {
      hostAndPath: `${parsed.hostname}${parsed.pathname}`.toLowerCase(),
      pathname: parsed.pathname.toLowerCase(),
    };
  } catch {
    const lower = rawUrl.toLowerCase().split(/[?#]/)[0] ?? '';
    return { hostAndPath: lower, pathname: lower };
  }
}

export function isUpworkContentRoutePath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  return (
    lower.startsWith('/jobs/') ||
    lower.startsWith('/nx/search/') ||
    lower.startsWith('/nx/find-work/') ||
    lower.startsWith('/ab/messages/') ||
    lower.startsWith('/nx/proposals/')
  );
}

export function matchChallengeOrLoginUrl(
  rawUrl: string,
  guards?: AuthAndChallengeGuardsConfig,
): ChallengeUrlMatchResult {
  const { hostAndPath, pathname } = parseChallengeUrlParts(rawUrl);
  const effectiveGuards = guards ?? BUNDLED_SELECTORS.auth_and_challenge_guards;

  for (const pat of effectiveGuards?.login_url_patterns ?? [
    '/ab/account-security/login',
    '/login',
    '/nx/signup',
  ]) {
    if (hostAndPath.includes(pat.toLowerCase())) {
      return {
        matched: true,
        challengeType: 'login',
        matchedPattern: pat,
        category: 'login',
      };
    }
  }

  for (const pat of effectiveGuards?.challenge_url_patterns ?? [
    '/cdn-cgi/challenge-platform',
    'challenges.cloudflare.com',
  ]) {
    if (hostAndPath.includes(pat.toLowerCase())) {
      return {
        matched: true,
        challengeType: 'cloudflare',
        matchedPattern: pat,
        category: 'challenge',
      };
    }
  }

  if (
    !isUpworkContentRoutePath(pathname) &&
    (pathname.includes('two-factor') || pathname.includes('2fa') || pathname.includes('deviceauth'))
  ) {
    return {
      matched: true,
      challengeType: 'two_factor',
      category: 'two_factor',
    };
  }

  return { matched: false, challengeType: 'unknown' };
}
