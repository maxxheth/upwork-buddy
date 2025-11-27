/**
 * API layer for communicating with Upwork Buddy backend
 */

import type { ProfileState, ProfileApiResponse, JobInfo, AnalysisResponse } from './types';
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
      budget: jobInfo.budget,
      skills: jobInfo.skills,
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
        budget: jobInfo.budget,
        skills: jobInfo.skills,
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
      specSheetLength: data.spec_sheet_prompt?.length || 0,
      questionsCount: data.questions_for_client?.length || 0,
      tipsCount: data.tips_and_advice?.length || 0,
      hasTimeEstimate: !!data.time_estimate,
      hasWorkloadDivision: !!data.workload_division,
      hasToneAnalysis: !!data.tone_analysis
    });

    return data;
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
