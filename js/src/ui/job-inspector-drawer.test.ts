import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedJob } from '../types';
import { JobInspectorDrawer } from './job-inspector-drawer';

function makeJob(overrides: Partial<SavedJob> & { id: number }): SavedJob {
  return {
    job_title: `Job ${overrides.id}`,
    job_description: 'Overview description text',
    contract_type: 'fixed',
    budget: '$2,200.00',
    rate_range: '',
    rate_min: '',
    rate_max: '',
    budget_amount: '$2,200.00',
    experience_level: 'Expert',
    skills: 'Go, PostgreSQL',
    proposal: '',
    time_estimate: '',
    execution_prompt: '',
    tone_analysis: '',
    created_at: '2026-11-20T12:00:00Z',
    ai_enrichment_status: 'none',
    ...overrides,
  };
}

describe('JobInspectorDrawer', () => {
  let container: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="drawer-root"></div>';
    container = document.getElementById('drawer-root') as HTMLElement;
  });

  it('resets activeTab to overview on open(job) and preserves activeTab on updateJobIfOpen(job)', async () => {
    const enrichedJob = makeJob({
      id: 1,
      ai_enrichment_status: 'completed',
      ai_model: 'gemini-pro-orchestrator-neon',
      ai_effort: 'medium',
      ai_tokens_used: 850,
      proposal: 'Built production Go + PostgreSQL services.',
      execution_prompt: 'Scaffold service layer',
      portfolio_references: [
        {
          source: 'portfolio',
          display_name: 'Public Telemetry Engine',
          visibility: 'public',
          link: 'https://example.com/telemetry',
        },
        {
          source: 'active_project',
          display_name: 'Enterprise FinTech Ledger',
          visibility: 'anonymized',
          summary: 'Sanitized enterprise summary',
        },
      ],
    });

    const onEnrichJob = vi.fn(async () => enrichedJob);
    const onSaveProposalDraft = vi.fn(async () => undefined);

    const drawer = new JobInspectorDrawer({
      container,
      callbacks: { onEnrichJob, onSaveProposalDraft },
    });

    drawer.open(makeJob({ id: 1, job_description: 'First job overview' }));
    expect(drawer.getActiveTab()).toBe('overview');
    expect(container.textContent).toContain('First job overview');

    // Switch to AI Analysis tab
    container.querySelector<HTMLButtonElement>('[data-testid="drawer-tab-ai"]')?.click();
    expect(drawer.getActiveTab()).toBe('ai');

    // Polling update for the SAME open job preserves AI tab
    drawer.updateJobIfOpen(enrichedJob);
    expect(drawer.getActiveTab()).toBe('ai');
    expect(container.textContent).toContain('[PUBLIC]');
    expect(container.textContent).toContain('[ANONYMIZED/NDA]');
    expect(container.textContent).toContain('gemini-pro-orchestrator-neon');
    expect(container.textContent).toContain('850');

    // Save draft callback fires
    container.querySelector<HTMLButtonElement>('[data-testid="save-proposal-draft-btn"]')?.click();
    await vi.waitFor(() => expect(onSaveProposalDraft).toHaveBeenCalledTimes(1));

    // Close and open a DIFFERENT job -> MUST reset back to overview!
    drawer.close();
    drawer.open(
      makeJob({
        id: 2,
        job_title: 'Second Job',
        job_description: '<svg onload="window.__xss=2">Malicious description</svg>',
      }),
    );
    expect(drawer.getActiveTab()).toBe('overview');
    expect(container.textContent).toContain('Malicious description');
    expect(container.querySelector('svg[onload]')).toBeNull();

    // Escape closes drawer
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(drawer.getIsOpen()).toBe(false);
    drawer.destroy();
  });

  it('prevents stale in-flight enrich/save-draft promises from overwriting a newly opened job', async () => {
    let resolveEnrich!: (job: SavedJob | null) => void;
    let resolveSave!: () => void;

    const onEnrichJob = vi.fn(
      () =>
        new Promise<SavedJob | null>((res) => {
          resolveEnrich = res;
        }),
    );
    const onSaveProposalDraft = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveSave = res;
        }),
    );

    const drawer = new JobInspectorDrawer({
      container,
      callbacks: { onEnrichJob, onSaveProposalDraft },
    });

    // C3.4: handleEnrichClick race
    drawer.open(makeJob({ id: 1, job_title: 'Job A' }));
    container.querySelector<HTMLButtonElement>('[data-testid="drawer-tab-ai"]')?.click();
    container.querySelector<HTMLButtonElement>('[data-testid="drawer-enrich-btn"]')?.click();

    drawer.open(makeJob({ id: 2, job_title: 'Job B', proposal: 'Prop B' }));
    resolveEnrich(makeJob({ id: 1, job_title: 'Job A Enriched', proposal: 'Enriched A' }));
    await Promise.resolve();
    await Promise.resolve();

    expect(drawer.getCurrentJobId()).toBe(2);
    expect(container.textContent).toContain('Job B');
    expect(container.textContent).not.toContain('Job A Enriched');

    // C3.6: handleSaveDraftClick race
    drawer.open(makeJob({ id: 1, job_title: 'Job A', proposal: 'Prop A' }));
    container.querySelector<HTMLButtonElement>('[data-testid="drawer-tab-ai"]')?.click();
    container.querySelector<HTMLButtonElement>('[data-testid="save-proposal-draft-btn"]')?.click();

    drawer.open(makeJob({ id: 2, job_title: 'Job B' }));
    resolveSave();
    await Promise.resolve();
    await Promise.resolve();

    container.querySelector<HTMLButtonElement>('[data-testid="drawer-tab-ai"]')?.click();
    expect(container.textContent).not.toContain('Saved as proposal draft.');
    drawer.destroy();
  });

  it('guards missing attachment urls, escapes client_activity, updates visibility changes, and surfaces failed enrichment', async () => {
    const onEnrichJob = vi.fn(async (job: SavedJob) => ({
      ...job,
      ai_enrichment_status: 'failed',
      ai_enrichment_error: 'Ollama timeout',
    }));
    const drawer = new JobInspectorDrawer({
      container,
      callbacks: { onEnrichJob, onSaveProposalDraft: vi.fn(async () => undefined) },
    });

    // C4.3 + Item 8: undefined attachment.url + XSS in client_activity + legacy portfolio ref
    drawer.open(
      makeJob({
        id: 99,
        attachments: [{ filename: 'no-url.pdf', url: undefined as unknown as string }],
        client_activity: {
          interviewing: '<img src=x onerror=alert(1)>' as unknown as number,
          invites_sent: 2,
          unanswered_invites: 1,
        },
        portfolio_references: [
          {
            source: 'active_project',
            display_name: 'Proj X',
            visibility: 'anonymized',
          },
        ],
      }),
    );
    expect(container.textContent).toContain('no-url.pdf (unsafe link blocked)');
    expect(container.querySelector('img[src="x"]')).toBeNull();

    // C3.5: updateJobIfOpen detects visibility change when updated_at and array lengths are unchanged
    container.querySelector<HTMLButtonElement>('[data-testid="drawer-tab-ai"]')?.click();
    expect(container.textContent).toContain('[ANONYMIZED/NDA]');

    drawer.updateJobIfOpen(
      makeJob({
        id: 99,
        portfolio_references: [
          {
            source: 'active_project',
            display_name: 'Proj X',
            visibility: 'public',
          },
        ],
      }),
    );
    expect(container.textContent).toContain('[PUBLIC]');
    expect(container.textContent).not.toContain('[ANONYMIZED/NDA]');

    // Item 10: failed enrichment does not show "AI analysis complete."
    container.querySelector<HTMLButtonElement>('[data-testid="drawer-enrich-btn"]')?.click();
    await vi.waitFor(() => {
      const banner = container.querySelector('[data-testid="drawer-action-feedback"]');
      expect(banner?.textContent).toContain('Ollama timeout');
      expect(banner?.classList.contains('dash-banner-error')).toBe(true);
    });
    expect(container.textContent).not.toContain('AI analysis complete.');
    drawer.destroy();
  });

  it('escapes client_reviews XSS payloads and falls back to legacy title when display_name is empty', () => {
    const drawer = new JobInspectorDrawer({
      container,
      callbacks: {
        onEnrichJob: vi.fn(async () => null),
        onSaveProposalDraft: vi.fn(async () => undefined),
      },
    });

    drawer.open(
      makeJob({
        id: 78,
        client_rating: 4.9,
        client_reviews: '<img src=x onerror="window.__xss=1">' as unknown as number,
        portfolio_references: [
          {
            source: 'active_project',
            display_name: '',
            title: 'Legacy Fallback Title',
            visibility: 'public',
          } as unknown as NonNullable<SavedJob['portfolio_references']>[number],
        ],
      }),
    );

    expect(container.querySelectorAll('img').length).toBe(0);
    expect(container.querySelectorAll('[onerror]').length).toBe(0);
    expect(container.textContent).toContain('4.9 (<img src=x onerror="window.__xss=1"> reviews)');

    container.querySelector<HTMLButtonElement>('[data-testid="drawer-tab-ai"]')?.click();
    expect(container.textContent).toContain('Legacy Fallback Title');
    expect(container.textContent).not.toContain('Untitled Reference');
    drawer.destroy();
  });

  it('normalizes non-finite numeric client_reviews and client_activity counts to 0', () => {
    const drawer = new JobInspectorDrawer({
      container,
      callbacks: {
        onEnrichJob: vi.fn(async () => null),
        onSaveProposalDraft: vi.fn(async () => undefined),
      },
    });

    drawer.open(
      makeJob({
        id: 79,
        client_rating: 4.5,
        client_reviews: Number.NaN,
        client_activity: {
          interviewing: Number.POSITIVE_INFINITY,
          invites_sent: Number.NaN,
          unanswered_invites: Number.NEGATIVE_INFINITY,
        },
      }),
    );

    expect(container.textContent).toContain('4.5 (0 reviews)');
    expect(container.textContent).toContain('interviewing 0 · invites 0 · unanswered 0');
    drawer.destroy();
  });

  it('does not mutate DOM after destroy() when in-flight enrich, save-draft, or copy-prompt settle', async () => {
    let resolveEnrich!: (job: SavedJob | null) => void;
    let rejectEnrich!: (err: unknown) => void;
    let resolveSave!: () => void;
    let rejectSave!: (err: unknown) => void;

    const drawer1 = new JobInspectorDrawer({
      container,
      callbacks: {
        onEnrichJob: () =>
          new Promise<SavedJob | null>((res, rej) => {
            resolveEnrich = res;
            rejectEnrich = rej;
          }),
        onSaveProposalDraft: () =>
          new Promise<void>((res, rej) => {
            resolveSave = res;
            rejectSave = rej;
          }),
      },
    });

    const job = makeJob({
      id: 1,
      proposal: 'Existing proposal text',
      execution_prompt: 'Execute step 1',
    });

    // Case 1: enrich resolves after destroy()
    drawer1.open(job);
    container.querySelector<HTMLButtonElement>('[data-testid="drawer-tab-ai"]')?.click();
    container.querySelector<HTMLButtonElement>('[data-testid="drawer-enrich-btn"]')?.click();
    const enrichHtml = container.innerHTML;
    drawer1.destroy();
    resolveEnrich(makeJob({ id: 1, proposal: 'Updated after destroy' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(container.innerHTML).toBe(enrichHtml);

    // Subsequent lifecycle calls after destroy() must be no-ops
    drawer1.open(makeJob({ id: 2 }));
    drawer1.updateJobIfOpen(makeJob({ id: 1, job_title: 'Mutated' }));
    drawer1.close();
    drawer1.render();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(container.innerHTML).toBe(enrichHtml);

    // Case 2: enrich rejects after destroy()
    const drawer2 = new JobInspectorDrawer({
      container,
      callbacks: {
        onEnrichJob: () =>
          new Promise<SavedJob | null>((res, rej) => {
            resolveEnrich = res;
            rejectEnrich = rej;
          }),
        onSaveProposalDraft: async () => undefined,
      },
    });
    drawer2.open(job);
    container.querySelector<HTMLButtonElement>('[data-testid="drawer-tab-ai"]')?.click();
    container.querySelector<HTMLButtonElement>('[data-testid="drawer-enrich-btn"]')?.click();
    const enrichRejectHtml = container.innerHTML;
    drawer2.destroy();
    rejectEnrich(new Error('Dashboard destroyed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(container.innerHTML).toBe(enrichRejectHtml);

    // Case 3: save-draft resolves or rejects after destroy()
    const drawer3 = new JobInspectorDrawer({
      container,
      callbacks: {
        onEnrichJob: async () => null,
        onSaveProposalDraft: () =>
          new Promise<void>((res, rej) => {
            resolveSave = res;
            rejectSave = rej;
          }),
      },
    });
    drawer3.open(job);
    container.querySelector<HTMLButtonElement>('[data-testid="drawer-tab-ai"]')?.click();
    container.querySelector<HTMLButtonElement>('[data-testid="save-proposal-draft-btn"]')?.click();
    const saveResolveHtml = container.innerHTML;
    drawer3.destroy();
    resolveSave();
    await Promise.resolve();
    await Promise.resolve();
    expect(container.innerHTML).toBe(saveResolveHtml);

    const drawer4 = new JobInspectorDrawer({
      container,
      callbacks: {
        onEnrichJob: async () => null,
        onSaveProposalDraft: () =>
          new Promise<void>((res, rej) => {
            resolveSave = res;
            rejectSave = rej;
          }),
      },
    });
    drawer4.open(job);
    container.querySelector<HTMLButtonElement>('[data-testid="drawer-tab-ai"]')?.click();
    container.querySelector<HTMLButtonElement>('[data-testid="save-proposal-draft-btn"]')?.click();
    const saveRejectHtml = container.innerHTML;
    drawer4.destroy();
    rejectSave(new Error('Dashboard destroyed'));
    await Promise.resolve();
    await Promise.resolve();
    expect(container.innerHTML).toBe(saveRejectHtml);

    // Case 4: copy-prompt settles after destroy()
    let resolveClipboard!: () => void;
    const origClipboard = navigator.clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: vi.fn(
          () =>
            new Promise<void>((res) => {
              resolveClipboard = res;
            }),
        ),
      },
    });
    try {
      const drawer5 = new JobInspectorDrawer({
        container,
        callbacks: {
          onEnrichJob: async () => null,
          onSaveProposalDraft: async () => undefined,
        },
      });
      drawer5.open(job);
      container.querySelector<HTMLButtonElement>('[data-testid="drawer-tab-ai"]')?.click();
      container
        .querySelector<HTMLButtonElement>('[data-testid="copy-execution-prompt-btn"]')
        ?.click();
      const copyHtml = container.innerHTML;
      drawer5.destroy();
      resolveClipboard();
      await Promise.resolve();
      await Promise.resolve();
      expect(container.innerHTML).toBe(copyHtml);
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: origClipboard,
      });
    }
  });
});
