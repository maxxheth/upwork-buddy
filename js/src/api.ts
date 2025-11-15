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

    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }

    return await response.json();
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
