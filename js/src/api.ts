/**
 * API layer for communicating with Upwork Buddy backend
 */

import type { ProfileState, ProfileApiResponse, JobInfo, AnalysisResponse, SaveJobRequest, SavedJob, SavedJobsResponse, TemplatesListResponse, TemplateCategory, GenerateAgentsRequest, GenerateAgentsResponse, GeneratedAgent } from './types';
import { CONFIG } from './types';

export class ApiClient {
  /**
   * Load profile from API
   */
  async loadProfile(): Promise<ProfileState | null> {
    try {
      const response = await fetch(CONFIG.profileApiEndpoint, { method: 'GET' });
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
    const response = await fetch(CONFIG.profileApiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        description: profile.description,
        skills: profile.skills,
        portfolio_items: profile.portfolioItems
      })
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
  async analyzeJob(jobInfo: JobInfo, userProfile: string, userSkills: string): Promise<AnalysisResponse> {
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
      userSkillsLength: userSkills.length
    });

    const response = await fetch(`${CONFIG.apiBaseUrl}/api/analyze-job`, {
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
        user_skills: userSkills
      })
    });

    console.log('📡 API: Response status', response.status, response.statusText);

    if (!response.ok) {
      console.error('❌ API: Request failed', response.status, response.statusText);
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
      hasToneAnalysis: !!data.tone_analysis
    });

    return data;
  }

  /**
   * Save a job analysis to the backend
   */
  async saveJob(job: SaveJobRequest): Promise<{ id: number; job_title: string; created_at: string }> {
    const response = await fetch(CONFIG.jobsApiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job)
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
      const response = await fetch(CONFIG.jobsApiEndpoint, { method: 'GET' });
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
    const response = await fetch(`${CONFIG.jobsApiEndpoint}/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) {
      throw new Error(`Delete job failed: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * List available template categories
   */
  async listTemplates(): Promise<TemplatesListResponse> {
    const response = await fetch(`${CONFIG.apiBaseUrl}/api/templates`, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`List templates failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Get full details for a template category
   */
  async getTemplate(name: string): Promise<TemplateCategory> {
    const response = await fetch(`${CONFIG.apiBaseUrl}/api/templates/${encodeURIComponent(name)}`, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`Get template failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Generate agents from a template category
   */
  async generateAgents(request: GenerateAgentsRequest): Promise<GenerateAgentsResponse> {
    const response = await fetch(`${CONFIG.apiBaseUrl}/api/agents/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
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
    const response = await fetch(`${CONFIG.apiBaseUrl}/api/agents`, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`List agents failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Download selected agents as a zip file
   */
  async downloadAgents(agentNames: string[]): Promise<Blob> {
    const response = await fetch(`${CONFIG.apiBaseUrl}/api/agents/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_names: agentNames })
    });
    if (!response.ok) {
      throw new Error(`Download agents failed: ${response.status} ${response.statusText}`);
    }
    return response.blob();
  }

  /**
   * Map API response to ProfileState
   */
  private mapProfileResponse(payload: ProfileApiResponse): ProfileState {
    if (!payload || typeof payload !== 'object') {
      return { description: '', skills: '', portfolioItems: [] };
    }

    const items = Array.isArray(payload.portfolio_items)
      ? payload.portfolio_items
      : Array.isArray(payload.portfolioItems)
        ? payload.portfolioItems
        : [];

    return {
      description: payload.description || '',
      skills: payload.skills || '',
      portfolioItems: items.map(item => ({
        title: item.title || '',
        link: item.link || '',
        description: item.description || ''
      }))
    };
  }
}
