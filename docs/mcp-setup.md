# Upwork Buddy Local Daemon, Native Messaging Host & MCP Setup

This guide covers optional host-level setup for running the Upwork Buddy daemon in the background, pairing Chrome/Firefox via Native Messaging, and wiring local AI agents to the embedded Go MCP server.

> **Note:** Repository scripts and templates are provided in-repo; host-level `systemd --user` and Native Messaging installation is left to you as an explicit manual step.

---

## 1. Optional `systemd --user` Daemon Service (Linux)

1. Build the Go daemon binary:
   ```bash
   make build
   ```
2. Review `scripts/upwork-buddy.service` before installing:
   - `WorkingDirectory=/var/www/upwork-buddy` ensures relative default config paths (`templates.yaml`, `configs/selectors/upwork.yaml`) resolve reliably.
   - If you run the binary from another working directory (for example via Native Messaging auto-launch), set explicit absolute paths in `~/.config/upwork-buddy/env` or `.env`:
     ```dotenv
     TEMPLATES_PATH=/var/www/upwork-buddy/templates.yaml
     SELECTORS_PATH=/var/www/upwork-buddy/configs/selectors/upwork.yaml
     ```
3. Install and enable the user service:
   ```bash
   mkdir -p ~/.config/systemd/user
   cp scripts/upwork-buddy.service ~/.config/systemd/user/
   systemctl --user daemon-reload
   systemctl --user enable --now upwork-buddy.service
   ```
4. Check status and logs:
   ```bash
   systemctl --user status upwork-buddy.service
   journalctl --user -u upwork-buddy.service -f
   ```

---

## 2. Optional Chrome / Firefox Native Messaging Host

Native Messaging allows the extension Popup and Background Service Worker to launch/wake the local `upwork-buddy` daemon and bootstrap the Bearer token (`~/.config/upwork-buddy/token`) without manual copy-paste.

1. Build both binaries:
   ```bash
   make build build-native-host
   ```
2. Find your unpacked or store Extension ID in `chrome://extensions` (with Developer Mode enabled).
3. Preview the manifest installation with `--dry-run`:
   ```bash
   ./scripts/install-native-host.sh --extension-id <EXTENSION_ID> --dry-run
   ```
4. Install for Chrome (or `--browser chromium|brave|firefox|all`):
   ```bash
   make install-native-host ARGS="--extension-id <EXTENSION_ID>"
   ```
5. If Chrome launches `upwork-buddy serve` from Chrome's working directory, place `TEMPLATES_PATH=/var/www/upwork-buddy/templates.yaml` and `SELECTORS_PATH=/var/www/upwork-buddy/configs/selectors/upwork.yaml` (plus DB settings) in `~/.config/upwork-buddy/env` or `/var/www/upwork-buddy/.env`.

---

## 3. MCP Server Overview & Transports

The embedded Go MCP server (`github.com/modelcontextprotocol/go-sdk v1.8.0`) exposes **22 tools** (`upwork_session_status`, `upwork_audit_selectors`, `upwork_list_tabs`, `upwork_capture_ui_diagnostic`, `upwork_get_ui_diagnostic`, `upwork_test_selector_patch`, `upwork_apply_selector_patch`, `upwork_search_jobs`, `upwork_get_job_details`, `upwork_list_saved_jobs`, `upwork_analyze_job`, `upwork_manage_search_profiles`, `upwork_draft_proposal`, `upwork_fill_proposal_form`, `upwork_submit_proposal`, `upwork_sync_proposals`, `upwork_list_conversations`, `upwork_get_conversation`, `upwork_draft_message`, `upwork_send_message`, `upwork_profile`, `upwork_generate_project_agents`) and **7 JSON resources** (`upwork://profile`, `upwork://jobs/hot`, `upwork://proposals/pending-approval`, `upwork://proposals/active`, `upwork://messages/unread`, `upwork://selectors/health`, `upwork://diagnostics/latest`).

### Closed-Loop UI Diagnostic & Self-Healing Selector Workflow

When the in-page banner warns `Some selectors need updating (<field>)`:
1. Click **Diagnose & Capture** on the warning banner (or call `upwork_capture_ui_diagnostic` with `use_active_tab: true`). This captures a PII-redacted pruned DOM snapshot, repetitive sibling patterns, broken-field anchor HTML, ranked candidate selectors, and exports `snapshot.json`, `pruned.html`, and `diagnostic.md` under `DIAGNOSTICS_DIR` (`diagnostics/captures/`).
2. Inspect the latest capture with `upwork_get_ui_diagnostic` (or read `upwork://diagnostics/latest`).
3. Dry-run a candidate rule non-destructively via `upwork_test_selector_patch` (`view`, `field`, `selectors`) to verify extracted sample values, zero sibling regressions, and valid YAML diff.
4. Atomically patch `configs/selectors/upwork.yaml` via `upwork_apply_selector_patch`, which backs up the prior YAML to `configs/selectors/.backups/upwork.<timestamp>.yaml` and broadcasts `selectors.reload` over WebSocket so Chrome updates live extraction without rebuilding the extension. Roll back anytime via `POST /api/diagnostics/rollback` or the **Selectors -> Rollback Last Patch** button in the Side Panel.

Two transports are supported:

1. **Streamable HTTP (Recommended for multi-agent concurrency):**
   - Endpoint: `http://127.0.0.1:9090/mcp` (requires `MCP_ENABLED=true`, default).
   - Auth header: `Authorization: Bearer <TOKEN>` where `<TOKEN>` comes from `BUDDY_API_TOKEN` or `~/.config/upwork-buddy/token`.
2. **Stdio (`upwork-buddy mcp`):**
   - Probes `http://127.0.0.1:9090/health` (or `--daemon-url` / `UPWORK_BUDDY_URL` / `BUDDY_API_URL`) and proxies all tool/resource calls over Streamable HTTP to the running daemon so it shares the live Chrome WebSocket bridge.
   - Optional flags:
     - `--daemon-url http://127.0.0.1:9090` — override daemon URL
     - `--auto-start` — spawn detached `upwork-buddy serve` if the daemon is not running
     - `--embedded` — run standalone Postgres-backed stdio MCP server directly (browser-backed tools return `EXTENSION_DISCONNECTED`)

Print your local Bearer token when configuring HTTP clients:

```bash
cat ~/.config/upwork-buddy/token
```

---

## 4. Client Configuration Snippets

### 4.1 Antigravity (`~/.gemini/antigravity/mcp_config.json`)

**Option A — Streamable HTTP (concurrent multi-client):**

```json
{
  "mcpServers": {
    "upwork-buddy": {
      "serverUrl": "http://127.0.0.1:9090/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_BUDDY_API_TOKEN>"
      }
    }
  }
}
```

**Option B — Stdio (`upwork-buddy mcp`):**

```json
{
  "mcpServers": {
    "upwork-buddy": {
      "command": "/var/www/upwork-buddy/dist/upwork-buddy",
      "args": ["mcp"],
      "env": {
        "UPWORK_BUDDY_URL": "http://127.0.0.1:9090",
        "TEMPLATES_PATH": "/var/www/upwork-buddy/templates.yaml",
        "SELECTORS_PATH": "/var/www/upwork-buddy/configs/selectors/upwork.yaml"
      }
    }
  }
}
```

### 4.2 Claude Code (`~/.claude.json` or `.mcp.json`)

**Option A — Streamable HTTP via CLI:**

```bash
claude mcp add --transport http upwork-buddy http://127.0.0.1:9090/mcp \
  --header "Authorization: Bearer $(cat ~/.config/upwork-buddy/token)"
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "upwork-buddy": {
      "type": "http",
      "url": "http://127.0.0.1:9090/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_BUDDY_API_TOKEN>"
      }
    }
  }
}
```

**Option B — Stdio via CLI / `.mcp.json`:**

```bash
claude mcp add upwork-buddy -- /var/www/upwork-buddy/dist/upwork-buddy mcp
```

```json
{
  "mcpServers": {
    "upwork-buddy": {
      "type": "stdio",
      "command": "/var/www/upwork-buddy/dist/upwork-buddy",
      "args": ["mcp"],
      "env": {
        "UPWORK_BUDDY_URL": "http://127.0.0.1:9090"
      }
    }
  }
}
```

### 4.3 OpenAI Codex CLI (`~/.codex/config.toml`)

**Option A — Streamable HTTP:**

```toml
[mcp_servers.upwork-buddy]
url = "http://127.0.0.1:9090/mcp"
bearer_token_env_var = "BUDDY_API_TOKEN"
```

Export `BUDDY_API_TOKEN="$(cat ~/.config/upwork-buddy/token)"` in your shell, or set `http_headers = { Authorization = "Bearer <YOUR_BUDDY_API_TOKEN>" }`.

**Option B — Stdio (`upwork-buddy mcp`):**

```toml
[mcp_servers.upwork-buddy]
command = "/var/www/upwork-buddy/dist/upwork-buddy"
args = ["mcp"]

[mcp_servers.upwork-buddy.env]
UPWORK_BUDDY_URL = "http://127.0.0.1:9090"
TEMPLATES_PATH = "/var/www/upwork-buddy/templates.yaml"
SELECTORS_PATH = "/var/www/upwork-buddy/configs/selectors/upwork.yaml"
```

### 4.4 Hermes (`~/.hermes/config.yaml`)

**Option A — Streamable HTTP:**

```yaml
mcp_servers:
  upwork-buddy:
    url: "http://127.0.0.1:9090/mcp"
    headers:
      Authorization: "Bearer <YOUR_BUDDY_API_TOKEN>"
```

**Option B — Stdio (`upwork-buddy mcp`):**

```yaml
mcp_servers:
  upwork-buddy:
    command: "/var/www/upwork-buddy/dist/upwork-buddy"
    args: ["mcp", "--auto-start"]
    env:
      UPWORK_BUDDY_URL: "http://127.0.0.1:9090"
      TEMPLATES_PATH: "/var/www/upwork-buddy/templates.yaml"
      SELECTORS_PATH: "/var/www/upwork-buddy/configs/selectors/upwork.yaml"
```

---

## 5. Verification Quick Check

```bash
# 1. Confirm daemon is healthy and MCP is enabled (HTTP 401 without token confirms auth is enforced)
curl -fsS http://127.0.0.1:9090/health
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:9090/mcp

# 2. Initialize an authenticated Streamable HTTP MCP session
TOKEN="$(cat ~/.config/upwork-buddy/token)"
curl -i -s -X POST http://127.0.0.1:9090/mcp \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'
```
