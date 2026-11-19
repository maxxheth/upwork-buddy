import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpworkBuddy } from '../main';
import { StateManager } from '../state';
import { STYLES } from '../styles';
import type { ProfileState } from '../types';
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
});
