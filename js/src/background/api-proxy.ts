import type { ApiProxyRequestMessage, ApiProxyResponseMessage } from '../api';
import type { ActivityLogEntry } from '../shared/protocol';
import { DEFAULT_API_URL } from '../shared/schemas';
import { apiUrlItem, authTokenItem } from '../shared/storage-items';

export interface DaemonProxyConfig {
  apiUrl: string;
  token: string;
}

export type ActivityRecorder = (entry: Omit<ActivityLogEntry, 'id' | 'timestamp'>) => void;

export function normalizeBaseApiUrl(rawBaseUrl?: string | null): string {
  const trimmed = (rawBaseUrl ?? '').trim();
  if (!trimmed) {
    return DEFAULT_API_URL;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return DEFAULT_API_URL;
    }
    return parsed.origin;
  } catch {
    return DEFAULT_API_URL;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === '127.0.0.1' || lower === 'localhost' || lower === '::1' || lower === '[::1]';
}

const CONTENT_SCRIPT_ALLOWED_COMMANDS = new Set([
  'PASSIVE_TAP_PAYLOAD',
  'GET_RUNTIME_STATUS',
  'BG_SELECTORS_GET',
  'OPEN_SIDEPANEL',
  'API_PROXY_REQUEST',
]);

export interface RuntimeSenderLike {
  id?: string;
  url?: string;
  origin?: string;
  tab?: { id?: number; url?: string };
}

export function isExtensionUiSender(
  sender: RuntimeSenderLike | undefined,
  runtimeId: string | undefined,
): boolean {
  if (runtimeId && sender?.id !== runtimeId) {
    return false;
  }
  if (!sender?.tab) {
    return true;
  }
  const senderUrl = sender.url ?? sender.origin ?? sender.tab.url ?? '';
  if (senderUrl.startsWith('chrome-extension://')) {
    if (runtimeId) {
      try {
        return new URL(senderUrl).hostname === runtimeId;
      } catch {
        return false;
      }
    }
    return true;
  }
  if (senderUrl.startsWith('moz-extension://')) {
    return Boolean(runtimeId ? sender.id === runtimeId : true);
  }
  return false;
}

export function isRuntimeSenderAuthorized(
  messageType: string,
  sender: RuntimeSenderLike | undefined,
  runtimeId: string | undefined,
): boolean {
  if (runtimeId && sender?.id !== runtimeId) {
    return false;
  }
  if (isExtensionUiSender(sender, runtimeId)) {
    return true;
  }
  if (!CONTENT_SCRIPT_ALLOWED_COMMANDS.has(messageType)) {
    return false;
  }
  const senderUrl = sender?.url ?? sender?.origin ?? sender?.tab?.url ?? '';
  if (!senderUrl) {
    return false;
  }
  try {
    return new URL(senderUrl).origin === 'https://www.upwork.com';
  } catch {
    return false;
  }
}

export function isContentScriptProxyAllowed(
  method: string,
  rawUrl: string,
  baseApiUrl: string,
): boolean {
  let target: URL;
  try {
    target = resolveDaemonUrl(rawUrl, baseApiUrl);
  } catch {
    return false;
  }
  const m = (method || 'GET').toUpperCase();
  const path = target.pathname;

  if (path === '/api/profile') {
    return m === 'GET' || m === 'POST';
  }
  if (path === '/api/analyze-job') {
    return m === 'POST';
  }
  if (path === '/api/jobs') {
    return m === 'GET' || m === 'POST';
  }
  if (/^\/api\/jobs\/\d+$/.test(path)) {
    return m === 'DELETE';
  }
  if (path === '/api/templates') {
    return m === 'GET';
  }
  if (path.startsWith('/api/templates/')) {
    const segment = path.slice('/api/templates/'.length);
    if (!segment || segment.includes('/')) {
      return false;
    }
    try {
      const decoded = decodeURIComponent(segment);
      if (decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\')) {
        return false;
      }
    } catch {
      return false;
    }
    return m === 'GET';
  }
  if (path === '/api/agents') {
    return m === 'GET';
  }
  if (path === '/api/agents/generate' || path === '/api/agents/download') {
    return m === 'POST';
  }
  return false;
}

function assertAllowedDaemonPath(target: URL): void {
  const allowedPath =
    target.pathname === '/health' ||
    target.pathname === '/api' ||
    target.pathname.startsWith('/api/') ||
    target.pathname === '/mcp' ||
    target.pathname.startsWith('/mcp/');
  if (!allowedPath) {
    throw new Error(`Refusing proxy request outside allowed daemon paths: ${target.pathname}`);
  }
}

export function resolveDaemonUrl(rawUrl: string, baseApiUrl: string): URL {
  const normalizedBase = normalizeBaseApiUrl(baseApiUrl);
  const base = new URL(normalizedBase);

  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) {
    throw new Error('Protocol-relative proxy URL is not allowed');
  }
  if (trimmed.startsWith('/')) {
    const resolved = new URL(trimmed, base);
    if (resolved.origin !== base.origin) {
      throw new Error('Relative proxy URL escaped configured daemon origin');
    }
    assertAllowedDaemonPath(resolved);
    return resolved;
  }

  let target = new URL(trimmed);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`Unsupported proxy URL protocol: ${target.protocol}`);
  }

  // Rewrite legacy hardcoded localhost/127.0.0.1:9090 URLs to the configured daemon base URL
  // so E2E tests running on ephemeral ports work seamlessly with legacy ApiClient constants.
  if (
    isLoopbackHost(target.hostname) &&
    (target.port === '9090' || target.port === '') &&
    target.origin !== base.origin &&
    isLoopbackHost(base.hostname)
  ) {
    target = new URL(target.pathname + target.search + target.hash, base);
  }

  if (target.origin !== base.origin) {
    throw new Error(
      `Refusing cross-origin proxy request to ${target.origin} (expected ${base.origin})`,
    );
  }
  assertAllowedDaemonPath(target);
  return target;
}

export function shouldAttachBearerToken(target: URL, baseApiUrl: string): boolean {
  const base = new URL(normalizeBaseApiUrl(baseApiUrl));
  if (target.origin !== base.origin) {
    return false;
  }
  const path = target.pathname;
  if (path === '/health') {
    return false;
  }
  return path === '/api' || path.startsWith('/api/') || path === '/mcp' || path.startsWith('/mcp/');
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function getStoredDaemonConfig(): Promise<DaemonProxyConfig> {
  const [rawUrl, rawToken] = await Promise.all([
    apiUrlItem.getValue().catch(() => DEFAULT_API_URL),
    authTokenItem.getValue().catch(() => ''),
  ]);
  return {
    apiUrl: normalizeBaseApiUrl(rawUrl),
    token: (rawToken ?? '').trim(),
  };
}

export async function proxyDaemonFetch(
  pathOrUrl: string,
  init: RequestInit = {},
  overrideConfig?: Partial<DaemonProxyConfig>,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const stored = await getStoredDaemonConfig();
  const baseApiUrl = normalizeBaseApiUrl(overrideConfig?.apiUrl ?? stored.apiUrl);
  const token = (overrideConfig?.token ?? stored.token).trim();

  const targetUrl = resolveDaemonUrl(pathOrUrl, baseApiUrl);
  const headers = new Headers(init.headers);

  if (token && shouldAttachBearerToken(targetUrl, baseApiUrl) && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  return fetchImpl(targetUrl.toString(), {
    ...init,
    headers,
  });
}

export async function handleApiProxyMessage(
  req: ApiProxyRequestMessage,
  opts?: {
    fetchImpl?: typeof fetch;
    recordActivity?: ActivityRecorder;
    overrideConfig?: Partial<DaemonProxyConfig>;
  },
): Promise<ApiProxyResponseMessage> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  try {
    const method = (req.method || 'GET').toUpperCase();
    const response = await proxyDaemonFetch(
      req.url,
      {
        method,
        headers: req.headers,
        body: req.body,
      },
      opts?.overrideConfig,
      fetchImpl,
    );

    const contentType = response.headers.get('content-type') ?? undefined;
    const etag = response.headers.get('etag') ?? undefined;
    const xSelectorVersion = response.headers.get('x-selector-version') ?? undefined;
    const buffer = await response.arrayBuffer();
    const bodyBase64 = buffer.byteLength > 0 ? encodeBytesToBase64(new Uint8Array(buffer)) : '';

    let pathname = req.url;
    try {
      pathname = new URL(req.url, DEFAULT_API_URL).pathname;
    } catch {
      // keep raw path
    }
    opts?.recordActivity?.({
      source: 'proxy',
      action: `${method} ${pathname}`,
      detail: `${response.status} ${response.statusText}`,
      status: response.ok || response.status === 304 ? 'ok' : 'warn',
    });

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      contentType,
      etag,
      xSelectorVersion,
      bodyBase64,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    opts?.recordActivity?.({
      source: 'proxy',
      action: `${(req.method || 'GET').toUpperCase()} ${req.url}`,
      detail: message,
      status: 'error',
    });
    return {
      ok: false,
      status: 0,
      statusText: 'Network Error',
      error: message,
    };
  }
}
