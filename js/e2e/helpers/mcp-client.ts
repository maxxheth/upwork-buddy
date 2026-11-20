import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import os from 'node:os';

export interface McpToolCallResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResourceInfo {
  uri: string;
  name?: string;
  mimeType?: string;
}

export interface McpResourceReadResult {
  contents: Array<{ uri: string; mimeType?: string; text?: string }>;
}

export interface McpClient {
  readonly transport: 'http' | 'stdio';
  readonly sessionId?: string;
  initialize(): Promise<{ protocolVersion: string; serverInfo: Record<string, unknown> }>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<McpToolCallResult>;
  listResources(): Promise<McpResourceInfo[]>;
  readResource(uri: string): Promise<McpResourceReadResult>;
  rawRequest?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponseShape {
  jsonrpc: string;
  id?: number | string | null;
  result?: unknown;
  error?: JsonRpcErrorShape;
}

function parseSsePayloads(rawText: string): JsonRpcResponseShape[] {
  const results: JsonRpcResponseShape[] = [];
  const blocks = rawText.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trim());
    if (dataLines.length === 0) {
      continue;
    }
    const joined = dataLines.join('\n');
    if (joined) {
      results.push(JSON.parse(joined) as JsonRpcResponseShape);
    }
  }
  return results;
}

export class McpHttpClient implements McpClient {
  readonly transport = 'http' as const;
  sessionId?: string;
  private readonly mcpUrl: string;
  private readonly apiToken: string;
  private nextId = 1;

  constructor(mcpUrl: string, apiToken: string) {
    this.mcpUrl = mcpUrl;
    this.apiToken = apiToken;
  }

  private async sendRpc(
    method: string,
    params?: Record<string, unknown>,
    isNotification = false,
  ): Promise<unknown> {
    const id = isNotification ? undefined : this.nextId++;
    const payload: Record<string, unknown> = {
      jsonrpc: '2.0',
      method,
    };
    if (id !== undefined) {
      payload.id = id;
    }
    if (params !== undefined) {
      payload.params = params;
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) {
      headers['mcp-session-id'] = this.sessionId;
    }

    const res = await fetch(this.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const respSessionId = res.headers.get('mcp-session-id');
    if (respSessionId) {
      this.sessionId = respSessionId;
    }

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`MCP HTTP ${res.status} on ${method}: ${errBody}`);
    }

    if (isNotification || res.status === 202 || res.status === 204) {
      return undefined;
    }

    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (!text.trim()) {
      return undefined;
    }

    let rpcResp: JsonRpcResponseShape | undefined;
    if (contentType.includes('text/event-stream')) {
      const messages = parseSsePayloads(text);
      rpcResp = messages.find((m) => m.id === id) ?? messages[messages.length - 1];
    } else {
      rpcResp = JSON.parse(text) as JsonRpcResponseShape;
    }

    if (!rpcResp) {
      throw new Error(`Empty MCP response for ${method}`);
    }
    if (rpcResp.error) {
      throw new Error(`MCP JSON-RPC error (${rpcResp.error.code}): ${rpcResp.error.message}`);
    }
    return rpcResp.result;
  }

  async initialize(): Promise<{ protocolVersion: string; serverInfo: Record<string, unknown> }> {
    const result = (await this.sendRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'upwork-buddy-e2e-http', version: '1.0.0' },
    })) as { protocolVersion: string; serverInfo: Record<string, unknown> };
    await this.sendRpc('notifications/initialized', {}, true);
    return result;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.sendRpc('tools/list', {})) as { tools: McpToolInfo[] };
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    return (await this.sendRpc('tools/call', {
      name,
      arguments: args,
    })) as McpToolCallResult;
  }

  async listResources(): Promise<McpResourceInfo[]> {
    const result = (await this.sendRpc('resources/list', {})) as {
      resources: McpResourceInfo[];
    };
    return result.resources;
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    return (await this.sendRpc('resources/read', { uri })) as McpResourceReadResult;
  }

  async rawRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.sendRpc(method, params);
  }

  async close(): Promise<void> {
    if (!this.sessionId) {
      return;
    }
    try {
      await fetch(this.mcpUrl, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          'mcp-session-id': this.sessionId,
        },
      });
    } catch {
      // ignore close errors
    } finally {
      this.sessionId = undefined;
    }
  }
}

export class McpStdioClient implements McpClient {
  readonly transport = 'stdio' as const;
  private readonly binaryPath: string;
  private readonly env: NodeJS.ProcessEnv;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = '';
  private readonly nonJsonStdoutLines: string[] = [];
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  constructor(binaryPath: string, env: NodeJS.ProcessEnv) {
    this.binaryPath = binaryPath;
    this.env = env;
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child) {
      return this.child;
    }
    const spawned = spawn(this.binaryPath, ['mcp'], {
      cwd: os.tmpdir(),
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = spawned;

    spawned.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      let newlineIdx = this.buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (line) {
          this.handleStdoutLine(line);
        }
        newlineIdx = this.buffer.indexOf('\n');
      }
    });

    spawned.once('exit', (code) => {
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`MCP stdio process exited with code ${code ?? 'null'}`));
      }
      this.pending.clear();
      this.child = null;
    });

    return spawned;
  }

  private handleStdoutLine(line: string): void {
    let parsed: JsonRpcResponseShape;
    try {
      parsed = JSON.parse(line) as JsonRpcResponseShape;
    } catch {
      this.nonJsonStdoutLines.push(line);
      return;
    }
    if (typeof parsed.id === 'number') {
      const handler = this.pending.get(parsed.id);
      if (handler) {
        this.pending.delete(parsed.id);
        if (parsed.error) {
          handler.reject(
            new Error(`MCP JSON-RPC error (${parsed.error.code}): ${parsed.error.message}`),
          );
        } else {
          handler.resolve(parsed.result);
        }
      }
    }
  }

  private sendRpc(
    method: string,
    params?: Record<string, unknown>,
    isNotification = false,
  ): Promise<unknown> {
    const proc = this.ensureStarted();
    if (isNotification) {
      const msg = JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} });
      proc.stdin.write(`${msg}\n`);
      return Promise.resolve(undefined);
    }

    const id = this.nextId++;
    const msg = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio timeout waiting for ${method}`));
      }, 30_000);
      timer.unref();

      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      proc.stdin.write(`${msg}\n`);
    });
  }

  getNonJsonStdoutLines(): string[] {
    return [...this.nonJsonStdoutLines];
  }

  async initialize(): Promise<{ protocolVersion: string; serverInfo: Record<string, unknown> }> {
    const result = (await this.sendRpc('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'upwork-buddy-e2e-stdio', version: '1.0.0' },
    })) as { protocolVersion: string; serverInfo: Record<string, unknown> };
    await this.sendRpc('notifications/initialized', {}, true);
    return result;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = (await this.sendRpc('tools/list', {})) as { tools: McpToolInfo[] };
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    return (await this.sendRpc('tools/call', {
      name,
      arguments: args,
    })) as McpToolCallResult;
  }

  async listResources(): Promise<McpResourceInfo[]> {
    const result = (await this.sendRpc('resources/list', {})) as {
      resources: McpResourceInfo[];
    };
    return result.resources;
  }

  async readResource(uri: string): Promise<McpResourceReadResult> {
    return (await this.sendRpc('resources/read', { uri })) as McpResourceReadResult;
  }

  async rawRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.sendRpc(method, params);
  }

  async close(): Promise<void> {
    const active = this.child;
    if (!active) {
      return;
    }
    this.child = null;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      active.once('exit', done);
      active.stdin.end();
      active.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (!settled) {
          active.kill('SIGKILL');
        }
      }, 3_000);
      timer.unref();
    });
  }
}

export function parseMcpToolJson<T = Record<string, unknown>>(result: McpToolCallResult): T {
  if (result.structuredContent !== undefined) {
    return result.structuredContent as T;
  }
  const textPart = result.content.find((c) => c.type === 'text' && typeof c.text === 'string');
  if (!textPart?.text) {
    throw new Error(`MCP tool result had no JSON text content: ${JSON.stringify(result)}`);
  }
  return JSON.parse(textPart.text) as T;
}
