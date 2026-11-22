import '../src/ui/dashboard.css';
import type { ApiTransport, WebSessionExchangeResponse } from '../src/types';
import { DashboardController } from '../src/ui/dashboard-controller';
import { escapeHtml } from '../src/utils';

const SESSION_TOKEN_KEY = 'upwork_buddy_web_session_token';
const REMEMBER_TOKEN_KEY = 'upwork_buddy_web_remember_token';

function getStoredToken(): string | null {
  try {
    const sess = window.sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (sess?.trim()) return sess.trim();
  } catch {
    // ignore storage restriction
  }
  try {
    const local = window.localStorage.getItem(REMEMBER_TOKEN_KEY);
    if (local?.trim()) return local.trim();
  } catch {
    // ignore storage restriction
  }
  return null;
}

function clearStoredTokens(): void {
  try {
    window.sessionStorage.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // ignore
  }
  try {
    window.localStorage.removeItem(REMEMBER_TOKEN_KEY);
  } catch {
    // ignore
  }
}

function storeSessionToken(token: string, remember: boolean): void {
  try {
    window.sessionStorage.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // ignore
  }
  try {
    if (remember) {
      window.localStorage.setItem(REMEMBER_TOKEN_KEY, token);
    } else {
      window.localStorage.removeItem(REMEMBER_TOKEN_KEY);
    }
  } catch {
    // ignore
  }
}

async function exchangeTicket(ticket: string): Promise<string | null> {
  try {
    const res = await window.fetch('/dashboard/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<WebSessionExchangeResponse>;
    if (typeof data.session_token === 'string' && data.session_token.trim()) {
      return data.session_token.trim();
    }
    return null;
  } catch {
    return null;
  }
}

async function validateToken(token: string): Promise<boolean> {
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const [healthRes, cfgRes] = await Promise.all([
      window.fetch('/api/health', { method: 'GET', headers }),
      window.fetch('/api/enrichment-config', { method: 'GET', headers }),
    ]);
    return healthRes.ok && cfgRes.ok;
  } catch {
    return false;
  }
}

function createWebTransport(
  token: string,
  onUnauthorized: () => void,
  isSessionDisposed?: () => boolean,
): ApiTransport {
  return async (path: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await window.fetch(path, {
      ...init,
      headers,
    });
    if (response.status === 401 && !isSessionDisposed?.()) {
      onUnauthorized();
    }
    return response;
  };
}

let activeController: DashboardController | null = null;

function mountDashboard(authRoot: HTMLElement, dashRoot: HTMLElement, token: string): void {
  authRoot.innerHTML = '';
  authRoot.hidden = true;
  dashRoot.hidden = false;

  activeController?.destroy();
  let unauthorizedHandled = false;
  const handleUnauthorized = () => {
    if (unauthorizedHandled) return;
    unauthorizedHandled = true;
    clearStoredTokens();
    activeController?.destroy();
    activeController = null;
    dashRoot.innerHTML = '';
    dashRoot.hidden = true;
    renderUnlockGate(
      authRoot,
      dashRoot,
      'Session expired or unauthorized (401). Enter your daemon token to continue.',
    );
  };

  activeController = new DashboardController({
    root: dashRoot,
    transport: createWebTransport(token, handleUnauthorized, () => unauthorizedHandled),
    surface: 'web',
    onUnauthorized: handleUnauthorized,
  });
  void activeController.init();
}

function renderUnlockGate(authRoot: HTMLElement, dashRoot: HTMLElement, initialError = ''): void {
  dashRoot.hidden = true;
  authRoot.hidden = false;
  authRoot.innerHTML = `
    <div class="web-unlock-shell">
      <div class="web-unlock-card">
        <h1>Upwork Buddy</h1>
        <p class="dash-muted">
          Enter your local daemon Bearer token (from <code>~/.config/upwork-buddy/token</code>) to unlock the dashboard.
        </p>
        <form id="web-unlock-form" class="web-unlock-form">
          <label for="web-token-input">
            Daemon Token
            <input
              id="web-token-input"
              name="token"
              type="password"
              data-testid="web-token-input"
              placeholder="Paste Bearer token..."
              autocomplete="off"
              required
            />
          </label>
          <label class="dash-checkbox-inline">
            <input type="checkbox" id="web-remember-checkbox" data-testid="web-remember-checkbox" />
            Remember in this browser (localStorage)
          </label>
          <button type="submit" id="web-unlock-btn" data-testid="web-unlock-btn" class="dash-btn-primary">
            Unlock
          </button>
          <div id="web-unlock-error" data-testid="web-unlock-error" class="dash-banner dash-banner-error" ${initialError ? '' : 'hidden'}>
            ${escapeHtml(initialError)}
          </div>
        </form>
      </div>
    </div>
  `;

  const form = authRoot.querySelector<HTMLFormElement>('#web-unlock-form');
  const tokenInput = authRoot.querySelector<HTMLInputElement>('#web-token-input');
  const rememberCb = authRoot.querySelector<HTMLInputElement>('#web-remember-checkbox');
  const unlockBtn = authRoot.querySelector<HTMLButtonElement>('#web-unlock-btn');
  const errorEl = authRoot.querySelector<HTMLElement>('#web-unlock-error');

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const candidate = tokenInput?.value.trim() ?? '';
      if (!candidate) return;
      if (unlockBtn) unlockBtn.disabled = true;
      if (errorEl) {
        errorEl.textContent = '';
        errorEl.hidden = true;
      }

      const ok = await validateToken(candidate);
      if (unlockBtn) unlockBtn.disabled = false;

      if (!ok) {
        if (errorEl) {
          errorEl.textContent = 'Invalid or unauthorized token (401). Please check and try again.';
          errorEl.hidden = false;
        }
        return;
      }

      storeSessionToken(candidate, Boolean(rememberCb?.checked));
      mountDashboard(authRoot, dashRoot, candidate);
    })();
  });
}

async function bootstrapWebDashboard(): Promise<void> {
  const authRoot = document.getElementById('web-auth-root');
  const dashRoot = document.getElementById('dashboard-root');
  if (!authRoot || !dashRoot) return;

  const currentUrl = new URL(window.location.href);
  const ticket = currentUrl.searchParams.get('ticket');
  if (ticket) {
    // Strip ?ticket= immediately before network exchange, preserving ?run=&fit=&q=&batch=
    currentUrl.searchParams.delete('ticket');
    window.history.replaceState(null, '', currentUrl.toString());

    const sessionToken = await exchangeTicket(ticket);
    if (sessionToken) {
      storeSessionToken(sessionToken, false);
      mountDashboard(authRoot, dashRoot, sessionToken);
      return;
    }

    renderUnlockGate(
      authRoot,
      dashRoot,
      'One-time login ticket invalid or expired (401). Enter your daemon token to unlock.',
    );
    return;
  }

  const stored = getStoredToken();
  if (stored) {
    const valid = await validateToken(stored);
    if (valid) {
      mountDashboard(authRoot, dashRoot, stored);
      return;
    }
    clearStoredTokens();
  }

  renderUnlockGate(authRoot, dashRoot);
}

document.addEventListener('DOMContentLoaded', () => {
  void bootstrapWebDashboard();
});
