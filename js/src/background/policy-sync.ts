import type { ApiProxyRequestMessage, ApiProxyResponseMessage } from '../api';
import { type PolicyMode, PolicyModeSchema } from '../shared/protocol';
import { DEFAULT_API_URL } from '../shared/schemas';
import { resolveDaemonUrl } from './api-proxy';

export interface PolicyStatePatch {
  policyMode?: PolicyMode;
  killSwitchActive?: boolean;
}

export function parsePolicyStateFromJson(raw: unknown): PolicyStatePatch | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const obj = raw as {
    mode?: unknown;
    policy_mode?: unknown;
    kill_switch_active?: unknown;
  };
  const patch: PolicyStatePatch = {};
  const parsedMode = PolicyModeSchema.safeParse(obj.mode ?? obj.policy_mode);
  if (parsedMode.success) {
    patch.policyMode = parsedMode.data;
  }
  if (typeof obj.kill_switch_active === 'boolean') {
    patch.killSwitchActive = obj.kill_switch_active;
  }
  if (patch.policyMode === undefined && patch.killSwitchActive === undefined) {
    return null;
  }
  return patch;
}

function decodeBase64Utf8(base64: string): string {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

export function extractPolicyPatchFromProxyResponse(
  req: Pick<ApiProxyRequestMessage, 'method' | 'url'>,
  res: Pick<ApiProxyResponseMessage, 'ok' | 'bodyBase64'>,
  baseApiUrl: string = DEFAULT_API_URL,
): PolicyStatePatch | null {
  if (!res.ok || !res.bodyBase64) {
    return null;
  }
  const method = (req.method || 'GET').toUpperCase();
  let pathname: string;
  try {
    pathname = resolveDaemonUrl(req.url, baseApiUrl).pathname;
  } catch {
    return null;
  }

  const isPolicyUpdate =
    pathname === '/api/policy' && (method === 'PUT' || method === 'POST' || method === 'GET');
  const isKillSwitch = pathname === '/api/policy/kill-switch' && method === 'POST';
  const isSessionStatus = pathname === '/api/session/status' && method === 'GET';
  if (!isPolicyUpdate && !isKillSwitch && !isSessionStatus) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64Utf8(res.bodyBase64)) as unknown;
    return parsePolicyStateFromJson(parsed);
  } catch {
    return null;
  }
}
