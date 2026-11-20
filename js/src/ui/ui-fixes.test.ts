import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../api';
import { UpworkBuddy } from '../main';
import { StateManager } from '../state';
import { STYLES } from '../styles';
import type { ProfileState } from '../types';
import { JobHistoryPanel } from './job-history';
import { Modal } from './modal';
import { ProfileConfigUI } from './profile-config';
import { ProjectsListUI } from './projects-list';

describe('M1 Frontend Bug Fixes', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.head.innerHTML = '';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('Bug 1: Modal close button works before/after mount and inside isolated root', () => {
    const modal = new Modal();
    modal.open();

    const overlay = document.getElementById('upwork-buddy-modal-overlay');
    const closeBtn = document.getElementById('upwork-buddy-close') as HTMLButtonElement | null;

    expect(overlay?.classList.contains('active')).toBe(true);
    expect(closeBtn).not.toBeNull();
    expect(closeBtn?.type).toBe('button');

    closeBtn?.click();
    expect(overlay?.classList.contains('active')).toBe(false);

    modal.open();
    overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay?.classList.contains('active')).toBe(false);
  });

  it('Bug 2: Template browser CSS is not trapped inside @media (max-width: 600px) and scopes spinner', () => {
    const mediaIdx = STYLES.indexOf('@media (max-width: 600px)');
    const templateIdx = STYLES.indexOf('.upwork-buddy-template-browser');

    expect(mediaIdx).toBeGreaterThan(-1);
    expect(templateIdx).toBeGreaterThan(mediaIdx);

    const mediaToTemplate = STYLES.slice(mediaIdx, templateIdx);
    const openBraces = (mediaToTemplate.match(/\{/g) || []).length;
    const closeBraces = (mediaToTemplate.match(/\}/g) || []).length;
    expect(openBraces).toBe(closeBraces);

    expect(STYLES).toContain('.upwork-buddy-agent-actions .upwork-buddy-loading');
  });

  it('Bug 3 & 4: ProfileConfigUI has zero inline onclick, rejects javascript: links, and escapes quotes in input values', () => {
    const profile: ProfileState = {
      description: 'Dev',
      skills: 'Go, TS',
      portfolioItems: [
        {
          title: 'Project "Quoted"',
          link: 'javascript:alert(1)',
          description: 'Unsafe link test',
        },
        {
          title: 'Safe Project',
          link: 'https://example.com/demo',
          description: 'Valid link',
        },
      ],
    };

    const stateManager = new StateManager();
    stateManager.setProfile(profile);

    const modalBody = document.createElement('div');
    const ui = new ProfileConfigUI(stateManager, modalBody);
    ui.render();

    expect(modalBody.innerHTML).not.toMatch(/on[a-z]+=/i);
    expect(modalBody.querySelector('a[href^="javascript:"]')).toBeNull();

    const safeLink = modalBody.querySelector('a[href="https://example.com/demo"]');
    expect(safeLink).not.toBeNull();
    expect(safeLink?.getAttribute('rel')).toBe('noopener noreferrer');

    const titleInput = modalBody.querySelector<HTMLInputElement>('.upwork-buddy-portfolio-title');
    expect(titleInput?.value).toBe('Project "Quoted"');

    // Collapsible header toggles without inline onclick
    const header = modalBody.querySelector<HTMLElement>(
      '.upwork-buddy-section-header[data-collapsible="true"]',
    );
    const content = header?.nextElementSibling;
    expect(content?.classList.contains('open')).toBe(false);
    header?.click();
    expect(content?.classList.contains('open')).toBe(true);
  });

  it('Bug 4: ProjectsListUI escapes data-cache-key attributes with quotes and opens matching project', async () => {
    const stateManager = new StateManager();
    const job = {
      title: 'Build "Quoted" Dashboard',
      description: 'Requires "clean" HTML escaping',
      contractType: 'fixed' as const,
      rateRange: '',
      rateMin: '',
      rateMax: '',
      budgetAmount: '$1000',
      budget: '$1000 fixed',
      experienceLevel: 'Expert',
      skills: 'React',
    };
    await stateManager.cacheAnalysis(job, { proposal: 'Proposal text' });

    const modalBody = document.createElement('div');
    const listUI = new ProjectsListUI(stateManager, modalBody);
    listUI.render();

    const item = modalBody.querySelector<HTMLElement>('.js-upwork-buddy-project');
    expect(item).not.toBeNull();
    expect(item?.getAttribute('data-cache-key')).toContain('Build "Quoted" Dashboard');

    item?.click();
    expect(modalBody.innerHTML).toContain('Proposal text');
    expect(modalBody.innerHTML).not.toMatch(/on[a-z]+=/i);
  });

  it('Bug 6A: UpworkBuddy does not show health warning banner on non-job pages without a job drawer', async () => {
    vi.spyOn(StateManager.prototype, 'initializeStorage').mockResolvedValue(undefined);
    vi.spyOn(StateManager.prototype, 'loadProfile').mockResolvedValue(undefined);

    new UpworkBuddy();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(document.getElementById('upwork-buddy-health-warning')).toBeNull();
  });

  it('M3 Carry-Forward: JobHistoryPanel escapes data-job-id attribute values', () => {
    const container = document.createElement('div');
    const panel = new JobHistoryPanel(container);
    panel.render([
      {
        id: '1" onmouseover="alert(1)' as unknown as number,
        job_title: 'Test Job',
        job_description: 'Desc',
        contract_type: 'fixed',
        budget: '$500',
        rate_range: '',
        rate_min: '',
        rate_max: '',
        budget_amount: '$500',
        experience_level: 'Expert',
        skills: 'Go',
        proposal: '',
        time_estimate: '',
        execution_prompt: '',
        tone_analysis: '',
        created_at: new Date().toISOString(),
      },
    ]);

    const card = container.querySelector('.upwork-buddy-job-card');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('onmouseover')).toBeNull();
    expect(container.innerHTML).toContain('data-job-id="1&quot; onmouseover=&quot;alert(1)"');
  });

  it('Diagnose & Capture banner button dispatches BG_CAPTURE_UI_DIAGNOSTIC and patched reload auto-clears warning', async () => {
    const sendSpy = vi.fn(async () => ({ ok: true }));
    const runtime = (globalThis as { browser?: { runtime?: { sendMessage?: unknown } } }).browser
      ?.runtime;
    if (runtime) {
      runtime.sendMessage = sendSpy;
    }
    vi.spyOn(StateManager.prototype, 'initializeStorage').mockResolvedValue(undefined);
    vi.spyOn(StateManager.prototype, 'loadProfile').mockResolvedValue(undefined);

    const drawer = document.createElement('div');
    drawer.className = 'job-details-content';
    drawer.innerHTML = `
      <h4><span class="flex-1">Diagnosable Job</span></h4>
      <div data-test="Description"><p class="text-body-sm">Broken skills markup test.</p></div>
      <div data-test="budget">$1,500</div>
      <ul><li><span data-cy="expertise"></span><strong>Expert</strong></li></ul>
      <div class="healed-chips"><span>Go</span><span>Docker</span></div>
    `;
    document.body.appendChild(drawer);

    const uiRoot = document.createElement('div');
    const styleRoot = document.createElement('div');
    document.body.appendChild(uiRoot);
    document.body.appendChild(styleRoot);

    const buddy = new UpworkBuddy({ uiRoot, styleRoot, skipLegacyStyleTag: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const warning = uiRoot.querySelector('#upwork-buddy-health-warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('skills');

    const diagnoseBtn = warning?.querySelector<HTMLButtonElement>('.upwork-buddy-health-diagnose');
    expect(diagnoseBtn).not.toBeNull();
    diagnoseBtn?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'BG_CAPTURE_UI_DIAGNOSTIC', useActiveTab: true }),
    );
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'OPEN_SIDEPANEL', tab: 'selectors' }),
    );

    const { BUNDLED_SELECTORS } = await import('../shared/selectors');
    await buddy.refreshSelectorsAndHealthCheck({
      ...BUNDLED_SELECTORS,
      views: {
        ...BUNDLED_SELECTORS.views,
        job_detail: {
          ...BUNDLED_SELECTORS.views.job_detail,
          fields: {
            ...BUNDLED_SELECTORS.views.job_detail.fields,
            skills: {
              selectors: ['.healed-chips span'],
              extract: 'list',
            },
          },
        },
      },
    });

    expect(uiRoot.querySelector('#upwork-buddy-health-warning')).toBeNull();
    buddy.destroy();
  });

  it('persists all 7 AI fields on post-analysis save and renders escaped deterministic score banner', async () => {
    vi.spyOn(StateManager.prototype, 'initializeStorage').mockResolvedValue(undefined);
    vi.spyOn(StateManager.prototype, 'loadProfile').mockResolvedValue(undefined);

    const saveSpy = vi
      .spyOn(ApiClient.prototype, 'saveJob')
      .mockResolvedValueOnce({
        id: 101,
        job_title: 'Full Stack Go + TS',
        created_at: '2026-11-20T00:00:00Z',
        score: 92,
        fit_label: 'Strong <Fit> & "Ready"',
        upserted: true,
      })
      .mockResolvedValueOnce({
        id: 101,
        job_title: 'Full Stack Go + TS',
        created_at: '2026-11-20T00:00:00Z',
        score: 92,
        fit_label: 'Strong <Fit> & "Ready"',
        upserted: true,
      });

    vi.spyOn(ApiClient.prototype, 'analyzeJob').mockResolvedValue({
      proposal: 'Proposal body',
      time_estimate: '2 weeks',
      workload_division: { ai_percent: 60, human_percent: 40 },
      questions_for_client: ['What is the target launch date?'],
      tips_and_advice: ['Set weekly milestones'],
      execution_prompt: 'Build step by step',
      tone_analysis: 'Direct and confident',
    });

    const drawer = document.createElement('div');
    drawer.className = 'job-details-content';
    drawer.innerHTML = `
      <h4><span class="flex-1">Full Stack Go + TS</span></h4>
      <div data-test="Description"><p class="text-body-sm">Need Go and TypeScript API work.</p></div>
      <div data-test="budget">$2,500</div>
      <ul><li><span data-cy="expertise"></span><strong>Expert</strong></li></ul>
      <div class="skills-list"><span data-test="Skill">Go</span><span data-test="Skill">TypeScript</span></div>
    `;
    document.body.appendChild(drawer);

    const uiRoot = document.createElement('div');
    const styleRoot = document.createElement('div');
    document.body.appendChild(uiRoot);
    document.body.appendChild(styleRoot);

    const buddy = new UpworkBuddy({ uiRoot, styleRoot, skipLegacyStyleTag: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await (
      buddy as unknown as { handleAnalyze: (saveOnly?: boolean) => Promise<void> }
    ).handleAnalyze(false);

    expect(saveSpy).toHaveBeenCalledTimes(2);
    const secondPayload = saveSpy.mock.calls[1]?.[0];
    expect(secondPayload).toMatchObject({
      proposal: 'Proposal body',
      time_estimate: '2 weeks',
      workload_division: { ai_percent: 60, human_percent: 40 },
      questions_for_client: ['What is the target launch date?'],
      tips_and_advice: ['Set weekly milestones'],
      execution_prompt: 'Build step by step',
      tone_analysis: 'Direct and confident',
    });

    const banner = document.querySelector('.upwork-buddy-score-banner');
    expect(banner).not.toBeNull();
    expect(banner?.innerHTML).toContain('Strong &lt;Fit&gt; &amp; "Ready"');
    expect(banner?.textContent).toContain('Strong <Fit> & "Ready"');
    expect(banner?.innerHTML).toContain('92');
    expect(banner?.querySelector('fit')).toBeNull();

    buddy.destroy();
  });

  it('suppresses health warning when dynamically mounted drawer hydrates skills within grace period', async () => {
    vi.spyOn(StateManager.prototype, 'initializeStorage').mockResolvedValue(undefined);
    vi.spyOn(StateManager.prototype, 'loadProfile').mockResolvedValue(undefined);

    const uiRoot = document.createElement('div');
    const styleRoot = document.createElement('div');
    document.body.appendChild(uiRoot);
    document.body.appendChild(styleRoot);

    const buddy = new UpworkBuddy({ uiRoot, styleRoot, skipLegacyStyleTag: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const drawer = document.createElement('div');
    drawer.className = 'job-details-content';
    drawer.innerHTML = `
      <h4><span class="flex-1">Hydrating Drawer Job</span></h4>
      <div data-test="Description"><p class="text-body-sm">Waiting for async skills hydration.</p></div>
      <div data-test="budget">$1,200</div>
      <ul><li><span data-cy="expertise"></span><strong>Expert</strong></li></ul>
    `;
    document.body.appendChild(drawer);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(uiRoot.querySelector('#upwork-buddy-health-warning')).toBeNull();

    const skillChip = document.createElement('span');
    skillChip.setAttribute('data-test', 'proposals-insights-v2-skill-chip');
    skillChip.innerHTML = '<span class="air3-line-clamp">TypeScript</span>';
    drawer.appendChild(skillChip);

    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(uiRoot.querySelector('#upwork-buddy-health-warning')).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(uiRoot.querySelector('#upwork-buddy-health-warning')).toBeNull();

    buddy.destroy();
  });

  it('auto-clears health warning on already-mounted drawer when skills arrive via DOM mutation', async () => {
    vi.spyOn(StateManager.prototype, 'initializeStorage').mockResolvedValue(undefined);
    vi.spyOn(StateManager.prototype, 'loadProfile').mockResolvedValue(undefined);

    const drawer = document.createElement('div');
    drawer.className = 'job-details-content';
    drawer.innerHTML = `
      <h4><span class="flex-1">Late Skills Job</span></h4>
      <div data-test="Description"><p class="text-body-sm">Skills arrive after initial check.</p></div>
      <div data-test="budget">$900</div>
      <ul><li><span data-cy="expertise"></span><strong>Intermediate</strong></li></ul>
    `;
    document.body.appendChild(drawer);

    const uiRoot = document.createElement('div');
    const styleRoot = document.createElement('div');
    document.body.appendChild(uiRoot);
    document.body.appendChild(styleRoot);

    const buddy = new UpworkBuddy({ uiRoot, styleRoot, skipLegacyStyleTag: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const warning = uiRoot.querySelector('#upwork-buddy-health-warning');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain('skills');

    const skillChip = document.createElement('span');
    skillChip.setAttribute('data-test', 'proposals-insights-v2-skill-chip');
    skillChip.innerHTML = '<span class="air3-line-clamp">Go</span>';
    drawer.appendChild(skillChip);

    await new Promise((resolve) => setTimeout(resolve, 320));
    expect(uiRoot.querySelector('#upwork-buddy-health-warning')).toBeNull();

    buddy.destroy();
  });

  it('removes health warning and resets state when drawer is removed from DOM', async () => {
    vi.spyOn(StateManager.prototype, 'initializeStorage').mockResolvedValue(undefined);
    vi.spyOn(StateManager.prototype, 'loadProfile').mockResolvedValue(undefined);

    const drawer = document.createElement('div');
    drawer.className = 'job-details-content';
    drawer.innerHTML = `
      <h4><span class="flex-1">Closing Drawer Job</span></h4>
      <div data-test="Description"><p class="text-body-sm">Missing skills before close.</p></div>
      <div data-test="budget">$1,000</div>
      <ul><li><span data-cy="expertise"></span><strong>Expert</strong></li></ul>
    `;
    document.body.appendChild(drawer);

    const uiRoot = document.createElement('div');
    const styleRoot = document.createElement('div');
    document.body.appendChild(uiRoot);
    document.body.appendChild(styleRoot);

    const buddy = new UpworkBuddy({ uiRoot, styleRoot, skipLegacyStyleTag: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(uiRoot.querySelector('#upwork-buddy-health-warning')).not.toBeNull();

    drawer.remove();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(uiRoot.querySelector('#upwork-buddy-health-warning')).toBeNull();

    buddy.destroy();
  });
});
