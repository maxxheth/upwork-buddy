/**
 * API layer for communicating with Upwork Buddy backend
 */

import { browser } from 'wxt/browser';
import type {
  AnalysisResponse,
  DownloadAgentsRequest,
  GenerateAgentsRequest,
  GenerateAgentsResponse,
  GeneratedAgent,
  JobInfo,
  ProfileApiResponse,
  ProfileState,
  SavedJob,
  SavedJobsResponse,
  SaveJobRequest,
  SyncedProfile,
  TemplateCategory,
  TemplatesListResponse,
} from './types';
import { CONFIG } from './types';

export type ApiTransport = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApiProxyRequestMessage {
  type: 'API_PROXY_REQUEST';
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface ApiProxyResponseMessage {
  ok: boolean;
  status: number;
  statusText: string;
  contentType?: string;
  etag?: string;
  xSelectorVersion?: string;
  bodyBase64?: string;
  error?: string;
}

function isContentScriptRuntime(): boolean {
  try {
    const proto = window.location?.protocol;
    return (
      typeof window !== 'undefined' &&
      (proto === 'https:' || proto === 'chrome-extension:' || proto === 'moz-extension:') &&
      typeof browser?.runtime?.sendMessage === 'function'
    );
  } catch {
    return false;
  }
}

function normalizeHeaders(headers?: HeadersInit): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value;
    }
    return result;
  }
  return { ...headers };
}

function decodeBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function createExtensionProxyTransport(): ApiTransport {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const message: ApiProxyRequestMessage = {
      type: 'API_PROXY_REQUEST',
      url,
      method: init?.method ?? 'GET',
      headers: normalizeHeaders(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };

    const reply = (await browser.runtime.sendMessage(message)) as
      | ApiProxyResponseMessage
      | undefined;
    if (!reply) {
      throw new Error('Background API proxy returned empty response');
    }
    if (reply.error) {
      throw new Error(reply.error);
    }

    const status = reply.status || 500;
    const statusText = reply.statusText ?? '';
    const headersRecord: Record<string, string> = {};
    if (reply.contentType) {
      headersRecord['Content-Type'] = reply.contentType;
    }
    if (reply.etag) {
      headersRecord.ETag = reply.etag;
    }
    if (reply.xSelectorVersion) {
      headersRecord['X-Selector-Version'] = reply.xSelectorVersion;
    }
    const responseHeaders = Object.keys(headersRecord).length > 0 ? headersRecord : undefined;

    if (status === 204 || status === 205 || status === 304) {
      return new Response(null, { status, statusText, headers: responseHeaders });
    }

    const bodyBytes = reply.bodyBase64 ? decodeBase64ToBytes(reply.bodyBase64) : new Uint8Array(0);
    return new Response(bodyBytes, {
      status,
      statusText,
      headers: responseHeaders,
    });
  };
}

export class ApiClient {
  private readonly customTransport?: ApiTransport;

  constructor(transport?: ApiTransport) {
    this.customTransport = transport;
  }

  private async request(url: string, init?: RequestInit): Promise<Response> {
    if (this.customTransport) {
      return this.customTransport(url, init);
    }
    if (isContentScriptRuntime()) {
      return createExtensionProxyTransport()(url, init);
    }
    return fetch(url, init);
  }

  /**
   * Load profile from API
   */
  async loadProfile(): Promise<ProfileState | null> {
    try {
      const response = await this.request(CONFIG.profileApiEndpoint, { method: 'GET' });
      if (response.ok) {
        const payload: ProfileApiResponse = await response.json();
        return this.mapProfileResponse(payload);
      }
      console.warn('Profile load returned status', response.status);
      return null;
    } catch (error) {
      console.warn('Profile load error', error);
      return null;
    }
  }

  /**
   * Save profile to API
   */
  async saveProfile(profile: ProfileState): Promise<ProfileState> {
    const response = await this.request(CONFIG.profileApiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        description: profile.description,
        skills: profile.skills,
        portfolio_items: profile.portfolioItems,
      }),
    });

    if (!response.ok) {
      throw new Error(`Profile save failed: ${response.status} ${response.statusText}`);
    }

    const saved: ProfileApiResponse = await response.json();
    return this.mapProfileResponse(saved);
  }

  /**
   * Analyze a job posting
   */
  async analyzeJob(
    jobInfo: JobInfo,
    userProfile: string,
    userSkills: string,
  ): Promise<AnalysisResponse> {
    console.log('🚀 API: Sending analyze request', {
      title: jobInfo.title,
      descriptionLength: jobInfo.description.length,
      contractType: jobInfo.contractType,
      budget: jobInfo.budget,
      rateRange: jobInfo.rateRange,
      budgetAmount: jobInfo.budgetAmount,
      skills: jobInfo.skills,
      experienceLevel: jobInfo.experienceLevel,
      profileLength: userProfile.length,
      userSkillsLength: userSkills.length,
    });

    const response = await this.request(`${CONFIG.apiBaseUrl}/api/analyze-job`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        job_title: jobInfo.title,
        job_description: jobInfo.description,
        contract_type: jobInfo.contractType,
        budget: jobInfo.budget,
        rate_range: jobInfo.rateRange,
        rate_min: jobInfo.rateMin,
        rate_max: jobInfo.rateMax,
        budget_amount: jobInfo.budgetAmount,
        skills: jobInfo.skills,
        experience_level: jobInfo.experienceLevel,
        user_profile: userProfile,
        user_skills: userSkills,
      }),
    });

    console.log('📡 API: Response status', response.status, response.statusText);

    if (!response.ok) {
      console.warn('⚠️ API: Request failed', response.status, response.statusText);
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    const data: AnalysisResponse = await response.json();
    console.log('✅ API: Received response', {
      proposalLength: data.proposal?.length || 0,
      executionPromptLength: data.execution_prompt?.length || 0,
      questionsCount: data.questions_for_client?.length || 0,
      tipsCount: data.tips_and_advice?.length || 0,
      hasTimeEstimate: !!data.time_estimate,
      hasWorkloadDivision: !!data.workload_division,
      hasToneAnalysis: !!data.tone_analysis,
    });

    return data;
  }

  /**
   * Save a job analysis to the backend
   */
  async saveJob(
    job: SaveJobRequest,
  ): Promise<{ id: number; job_title: string; created_at: string }> {
    const response = await this.request(CONFIG.jobsApiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job),
    });
    if (!response.ok) {
      throw new Error(`Save job failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Load all saved jobs from the backend
   */
  async loadJobs(): Promise<SavedJob[]> {
    try {
      const response = await this.request(CONFIG.jobsApiEndpoint, { method: 'GET' });
      if (!response.ok) {
        console.warn('Load jobs returned status', response.status);
        return [];
      }
      const data: SavedJobsResponse = await response.json();
      return data.jobs || [];
    } catch (error) {
      console.warn('Load jobs error', error);
      return [];
    }
  }

  /**
   * Delete a saved job
   */
  async deleteJob(id: number): Promise<void> {
    const response = await this.request(`${CONFIG.jobsApiEndpoint}/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Delete job failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * List available template categories
   */
  async listTemplates(): Promise<TemplatesListResponse> {
    const response = await this.request(`${CONFIG.apiBaseUrl}/api/templates`, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`List templates failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Get full details for a template category
   */
  async getTemplate(name: string): Promise<TemplateCategory> {
    const response = await this.request(
      `${CONFIG.apiBaseUrl}/api/templates/${encodeURIComponent(name)}`,
      { method: 'GET' },
    );
    if (!response.ok) {
      throw new Error(`Get template failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Generate agents from a template category
   */
  async generateAgents(request: GenerateAgentsRequest): Promise<GenerateAgentsResponse> {
    const response = await this.request(`${CONFIG.apiBaseUrl}/api/agents/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw new Error(`Generate agents failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * List all generated agents
   */
  async listAgents(): Promise<{ agents: GeneratedAgent[] }> {
    const response = await this.request(`${CONFIG.apiBaseUrl}/api/agents`, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`List agents failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Download selected agents as a zip file
   */
  async downloadAgents(
    agentNames: string[],
    options?: { template_name?: string; format?: string },
  ): Promise<Blob> {
    const body: DownloadAgentsRequest = {
      agent_names: agentNames,
      ...(options?.template_name ? { template_name: options.template_name } : {}),
      ...(options?.format ? { format: options.format } : {}),
    };
    const response = await this.request(`${CONFIG.apiBaseUrl}/api/agents/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Download agents failed: ${response.status} ${response.statusText}`);
    }
    return response.blob();
  }

  /**
   * Map API response to ProfileState (preserving server sync timestamp when present)
   */
  private mapProfileResponse(payload: ProfileApiResponse): ProfileState | SyncedProfile {
    if (!payload || typeof payload !== 'object') {
      return { description: '', skills: '', portfolioItems: [] };
    }

    const items = Array.isArray(payload.portfolio_items)
      ? payload.portfolio_items
      : Array.isArray(payload.portfolioItems)
        ? payload.portfolioItems
        : [];

    const mapped: ProfileState = {
      description: payload.description || '',
      skills: payload.skills || '',
      portfolioItems: items.map((item) => ({
        title: item.title || '',
        link: item.link || '',
        description: item.description || '',
      })),
    };

    const syncTimestamp = payload.lastSyncedAt ?? payload.last_synced_at ?? payload.updated_at;
    if (typeof syncTimestamp === 'string' && syncTimestamp.length > 0) {
      return {
        ...mapped,
        lastSyncedAt: syncTimestamp,
        isDirty: false,
      };
    }

    return mapped;
  }
}
