import type {
  MockServerConfig,
  MockServerStateSnapshot,
  RecordedRequest,
} from '../server/mock-types.ts';

export type * from '../server/mock-types.ts';

export class MockControlClient {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async health(): Promise<{ ok: boolean; port: number }> {
    const res = await fetch(`${this.baseUrl}/__mock/health`);
    if (!res.ok) {
      throw new Error(`Mock health check failed with status ${res.status}`);
    }
    return (await res.json()) as { ok: boolean; port: number };
  }

  async reset(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/__mock/reset`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`Mock reset failed with status ${res.status}`);
    }
  }

  async configure(patch: Partial<MockServerConfig>): Promise<MockServerConfig> {
    const res = await fetch(`${this.baseUrl}/__mock/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      throw new Error(`Mock configure failed with status ${res.status}`);
    }
    return (await res.json()) as MockServerConfig;
  }

  async setScenario(patch: Partial<MockServerConfig>): Promise<MockServerConfig> {
    return this.configure(patch);
  }

  async getRequests(pathPrefix?: string): Promise<RecordedRequest[]> {
    const suffix = pathPrefix ? `?pathPrefix=${encodeURIComponent(pathPrefix)}` : '';
    const res = await fetch(`${this.baseUrl}/__mock/requests${suffix}`);
    if (!res.ok) {
      throw new Error(`Mock getRequests failed with status ${res.status}`);
    }
    const data = (await res.json()) as { requests: RecordedRequest[] };
    return data.requests;
  }

  async getState(): Promise<MockServerStateSnapshot> {
    const res = await fetch(`${this.baseUrl}/__mock/state`);
    if (!res.ok) {
      throw new Error(`Mock getState failed with status ${res.status}`);
    }
    return (await res.json()) as MockServerStateSnapshot;
  }
}
