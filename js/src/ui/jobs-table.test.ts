import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SavedJob } from '../types';
import { getMatchedProjectBadges, JobsTable, parseNumericBudget } from './jobs-table';

function makeJob(overrides: Partial<SavedJob> & { id: number }): SavedJob {
  return {
    job_title: `Job ${overrides.id}`,
    job_description: 'Test description',
    contract_type: 'fixed',
    budget: '$1,000.00',
    rate_range: '',
    rate_min: '',
    rate_max: '',
    budget_amount: '$1,000.00',
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

describe('JobsTable & parseNumericBudget', () => {
  let tableWrap: HTMLElement;
  let paginationWrap: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '<div id="table-wrap"></div><div id="pagination-wrap"></div>';
    tableWrap = document.getElementById('table-wrap') as HTMLElement;
    paginationWrap = document.getElementById('pagination-wrap') as HTMLElement;
  });

  it('parses fixed and hourly budget strings numerically', () => {
    expect(
      parseNumericBudget(makeJob({ id: 1, contract_type: 'fixed', budget_amount: '$2,200.00' })),
    ).toBe(2200);
    expect(
      parseNumericBudget(makeJob({ id: 2, contract_type: 'fixed', budget_amount: '$900.00' })),
    ).toBe(900);
    expect(
      parseNumericBudget(
        makeJob({
          id: 3,
          contract_type: 'hourly',
          budget: '$80-$120/hr',
          budget_amount: '',
          rate_range: '$80 - $120/hr',
          rate_max: '120',
        }),
      ),
    ).toBe(120);
    expect(
      parseNumericBudget(
        makeJob({ id: 4, contract_type: '', budget: 'Budget N/A', budget_amount: '' }),
      ),
    ).toBeUndefined();
  });

  it('sorts budgets numerically across toggle clicks and keeps unknown budgets last', () => {
    const table = new JobsTable({
      tableWrap,
      paginationWrap,
      callbacks: {
        onInspectJob: vi.fn(),
        onEnrichSingleJob: vi.fn(),
        onStatusChange: vi.fn(),
        onSelectionChange: vi.fn(),
      },
    });

    table.setJobs([
      makeJob({ id: 1, job_title: 'Job 1000', budget: '$1,000.00', budget_amount: '$1,000.00' }),
      makeJob({ id: 2, job_title: 'Job 2200', budget: '$2,200.00', budget_amount: '$2,200.00' }),
      makeJob({ id: 3, job_title: 'Job 900', budget: '$900.00', budget_amount: '$900.00' }),
      makeJob({
        id: 4,
        job_title: 'Job Unknown',
        contract_type: '',
        budget: '',
        budget_amount: '',
      }),
      makeJob({ id: 5, job_title: 'Job 1500', budget: '$1,500.00', budget_amount: '$1,500.00' }),
    ]);

    const getOrderedTitles = () =>
      Array.from(tableWrap.querySelectorAll('tbody tr')).map(
        (tr) => tr.querySelector('.dash-job-title-btn')?.textContent ?? '',
      );

    const budgetHeader = tableWrap.querySelector<HTMLElement>('[data-testid="budget-header"]');
    expect(budgetHeader).not.toBeNull();
    budgetHeader?.click();
    const firstOrder = getOrderedTitles();
    expect(firstOrder[4]).toBe('Job Unknown');
    expect(firstOrder.slice(0, 4)).toEqual(['Job 2200', 'Job 1500', 'Job 1000', 'Job 900']);

    tableWrap.querySelector<HTMLElement>('[data-testid="budget-header"]')?.click();
    const secondOrder = getOrderedTitles();
    expect(secondOrder[4]).toBe('Job Unknown');
    expect(secondOrder.slice(0, 4)).toEqual(['Job 900', 'Job 1000', 'Job 1500', 'Job 2200']);
  });

  it('supports Shift+Click range selection, Select all matching, and persists selection across updates', () => {
    const onSelectionChange = vi.fn();
    const table = new JobsTable({
      tableWrap,
      paginationWrap,
      callbacks: {
        onInspectJob: vi.fn(),
        onEnrichSingleJob: vi.fn(),
        onStatusChange: vi.fn(),
        onSelectionChange,
      },
    });

    const jobs = [1, 2, 3, 4, 5, 6].map((id) => makeJob({ id, job_title: `Task ${id}` }));
    table.setJobs(jobs);

    const checkboxes = () => tableWrap.querySelectorAll<HTMLInputElement>('.dash-row-checkbox');
    checkboxes()[0].click();
    checkboxes()[4].dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }),
    );
    // Simulate browser native toggle before click when dispatching synthetic MouseEvent
    expect(table.getSelectedJobIds()).toEqual([1, 2, 3, 4, 5]);

    const headerCb = tableWrap.querySelector<HTMLInputElement>(
      '[data-testid="select-all-page-checkbox"]',
    );
    expect(headerCb?.indeterminate).toBe(true);

    // Selection persists when polling refreshes job objects
    table.setJobs(jobs.map((j) => ({ ...j, ai_enrichment_status: 'queued' })));
    expect(table.getSelectedJobIds()).toEqual([1, 2, 3, 4, 5]);

    table.setGlobalFilter('Task 6');
    paginationWrap
      .querySelector<HTMLButtonElement>('[data-testid="select-all-matching-btn"]')
      ?.click();
    expect(table.getSelectedJobIds()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(onSelectionChange).toHaveBeenCalled();
  });

  it('renders [NDA] badges and escapes hostile XSS strings and unsafe URLs', () => {
    const table = new JobsTable({
      tableWrap,
      paginationWrap,
      callbacks: {
        onInspectJob: vi.fn(),
        onEnrichSingleJob: vi.fn(),
        onStatusChange: vi.fn(),
        onSelectionChange: vi.fn(),
      },
    });

    table.setAnonymizedProjectLabels(['Enterprise FinTech Ledger']);
    table.setJobs([
      makeJob({
        id: 42,
        job_title: '<img src=x onerror="window.__xss=1">XSS Job',
        url: 'javascript:alert(1)',
        score: 88,
        fit_label: 'hot',
        score_breakdown: { matched_active_projects: ['Enterprise FinTech Ledger'] },
      }),
    ]);

    expect(tableWrap.querySelector('img[src="x"]')).toBeNull();
    expect(tableWrap.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(tableWrap.textContent).toContain('XSS Job');
    expect(tableWrap.textContent).toContain('Enterprise FinTech Ledger [NDA]');
  });

  it('resolves Shift+Click range selection accurately after sorting, across pagination, and when anchor is filtered out', () => {
    const createTbl = (pageSize = 50) =>
      new JobsTable({
        tableWrap,
        paginationWrap,
        pageSize,
        callbacks: {
          onInspectJob: vi.fn(),
          onEnrichSingleJob: vi.fn(),
          onStatusChange: vi.fn(),
          onSelectionChange: vi.fn(),
        },
      });

    // C1.3: Post-sort Shift+Click
    const sortedTable = createTbl();
    sortedTable.setJobs([1, 2, 3, 4, 5].map((id) => makeJob({ id, score: id * 10 })));
    tableWrap.querySelectorAll<HTMLInputElement>('.dash-row-checkbox')[0].click(); // id: 1
    tableWrap.querySelector<HTMLElement>('th[data-col-id="score"]')?.click(); // desc: [5,4,3,2,1]
    tableWrap
      .querySelectorAll<HTMLInputElement>('.dash-row-checkbox')[2]
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })); // id: 3
    expect(sortedTable.getSelectedJobIds()).toEqual([1, 2, 3]);

    // C1.4: Cross-pagination Shift+Click
    const pagedTable = createTbl(3);
    pagedTable.setJobs([1, 2, 3, 4, 5, 6].map((id) => makeJob({ id })));
    tableWrap.querySelectorAll<HTMLInputElement>('.dash-row-checkbox')[2].click(); // id: 3 on page 1
    paginationWrap.querySelector<HTMLButtonElement>('button[data-action="next-page"]')?.click();
    tableWrap
      .querySelectorAll<HTMLInputElement>('.dash-row-checkbox')[0]
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })); // id: 4 on page 2
    expect(pagedTable.getSelectedJobIds()).toEqual([3, 4]);

    // C1.5: Post-filter Shift+Click with filtered-out anchor
    const filteredTable = createTbl();
    filteredTable.setJobs([
      makeJob({ id: 1, job_title: 'Alpha 1' }),
      makeJob({ id: 2, job_title: 'Alpha 2' }),
      makeJob({ id: 3, job_title: 'Beta 3' }),
      makeJob({ id: 4, job_title: 'Beta 4' }),
      makeJob({ id: 5, job_title: 'Alpha 5' }),
    ]);
    tableWrap.querySelectorAll<HTMLInputElement>('.dash-row-checkbox')[4].click(); // Alpha 5 (id: 5)
    filteredTable.setGlobalFilter('Beta');
    tableWrap
      .querySelectorAll<HTMLInputElement>('.dash-row-checkbox')[0]
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true })); // Beta 3 (id: 3)
    expect(filteredTable.getSelectedJobIds()).toEqual([3, 5]);
  });

  it('handles parseNumericBudget currency edge cases, legacy portfolio titles, and preserves pagination on no-op filter', () => {
    // C2.2: Non-currency number ("100 hours") must not override $50/hr
    expect(
      parseNumericBudget(
        makeJob({
          id: 10,
          contract_type: 'hourly',
          budget: '$50/hr for 100 hours',
          rate_min: '',
          rate_max: '',
          rate_range: '',
        }),
      ),
    ).toBe(50);

    // C2.3: '0' in budget_amount falls back to budget '$1,200.00'
    expect(
      parseNumericBudget(
        makeJob({
          id: 11,
          contract_type: 'fixed',
          budget_amount: '0',
          budget: '$1,200.00',
        }),
      ),
    ).toBe(1200);

    const table = new JobsTable({
      tableWrap,
      paginationWrap,
      pageSize: 3,
      callbacks: {
        onInspectJob: vi.fn(),
        onEnrichSingleJob: vi.fn(),
        onStatusChange: vi.fn(),
        onSelectionChange: vi.fn(),
      },
    });

    table.setJobs(
      [1, 2, 3, 4, 5, 6].map((id) =>
        makeJob({
          id,
          portfolio_references:
            id === 4
              ? ([
                  { source: 'active_project', title: 'Legacy Active', visibility: 'anonymized' },
                ] as unknown as SavedJob['portfolio_references'])
              : undefined,
        }),
      ),
    );
    paginationWrap.querySelector<HTMLButtonElement>('button[data-action="next-page"]')?.click();
    expect(paginationWrap.querySelector('.dash-page-info')?.textContent).toBe('Page 2 of 2');
    expect(tableWrap.textContent).toContain('Legacy Active [NDA]');

    // No-op global filter call keeps Page 2 of 2
    table.setGlobalFilter('');
    expect(paginationWrap.querySelector('.dash-page-info')?.textContent).toBe('Page 2 of 2');
  });

  it('falls back to legacy portfolio title when display_name is empty', () => {
    const job = makeJob({
      id: 100,
      portfolio_references: [
        {
          source: 'active_project',
          display_name: '',
          title: 'Legacy Fallback Title',
          visibility: 'public',
        } as unknown as NonNullable<SavedJob['portfolio_references']>[number],
      ],
    });

    expect(getMatchedProjectBadges(job)).toEqual([
      { label: 'Legacy Fallback Title', isNda: false },
    ]);

    const table = new JobsTable({
      tableWrap,
      paginationWrap,
      callbacks: {
        onInspectJob: vi.fn(),
        onEnrichSingleJob: vi.fn(),
        onStatusChange: vi.fn(),
        onSelectionChange: vi.fn(),
      },
    });
    table.setJobs([job]);
    expect(tableWrap.textContent).toContain('Legacy Fallback Title');
  });

  it('guards non-finite ai_tokens_used tooltips and score sorting against NaN', () => {
    const table = new JobsTable({
      tableWrap,
      paginationWrap,
      callbacks: {
        onInspectJob: vi.fn(),
        onEnrichSingleJob: vi.fn(),
        onStatusChange: vi.fn(),
        onSelectionChange: vi.fn(),
      },
    });

    table.setJobs([
      makeJob({
        id: 1,
        job_title: 'Score 50',
        score: 50,
        ai_enrichment_status: 'completed',
        ai_tokens_used: Number.NaN,
      }),
      makeJob({ id: 2, job_title: 'Score NaN', score: Number.NaN }),
      makeJob({ id: 3, job_title: 'Score 10', score: 10 }),
      makeJob({ id: 4, job_title: 'Score 90', score: 90 }),
    ]);

    const badge = tableWrap.querySelector<HTMLElement>('[data-testid="enrichment-badge-1"]');
    expect(badge?.getAttribute('title')).not.toContain('NaN');

    tableWrap.querySelector<HTMLElement>('th[data-col-id="score"]')?.click();
    const descTitles = Array.from(tableWrap.querySelectorAll('tbody tr')).map(
      (tr) => tr.querySelector('.dash-job-title-btn')?.textContent ?? '',
    );
    expect(descTitles).toEqual(['Score 90', 'Score 50', 'Score 10', 'Score NaN']);
  });

  it('disables row Enrich button with Queued / Enriching... label while enrichment is in progress', () => {
    const onEnrichSingleJob = vi.fn();
    const table = new JobsTable({
      tableWrap,
      paginationWrap,
      callbacks: {
        onInspectJob: vi.fn(),
        onEnrichSingleJob,
        onStatusChange: vi.fn(),
        onSelectionChange: vi.fn(),
      },
    });

    table.setJobs([
      makeJob({ id: 1, ai_enrichment_status: 'none' }),
      makeJob({ id: 2, ai_enrichment_status: 'queued' }),
      makeJob({ id: 3, ai_enrichment_status: 'scraping_details' }),
      makeJob({ id: 4, ai_enrichment_status: 'analyzing' }),
      makeJob({ id: 5, ai_enrichment_status: 'completed' }),
      makeJob({ id: 6, ai_enrichment_status: 'failed' }),
    ]);

    const btn1 = tableWrap.querySelector<HTMLButtonElement>('[data-testid="row-enrich-btn-1"]');
    const btn2 = tableWrap.querySelector<HTMLButtonElement>('[data-testid="row-enrich-btn-2"]');
    const btn3 = tableWrap.querySelector<HTMLButtonElement>('[data-testid="row-enrich-btn-3"]');
    const btn4 = tableWrap.querySelector<HTMLButtonElement>('[data-testid="row-enrich-btn-4"]');
    const btn5 = tableWrap.querySelector<HTMLButtonElement>('[data-testid="row-enrich-btn-5"]');
    const btn6 = tableWrap.querySelector<HTMLButtonElement>('[data-testid="row-enrich-btn-6"]');

    expect(btn1?.disabled).toBe(false);
    expect(btn1?.textContent).toBe('Enrich');

    expect(btn2?.disabled).toBe(true);
    expect(btn2?.textContent).toBe('Queued');
    expect(btn2?.title).toBe('Enrichment in progress');

    expect(btn3?.disabled).toBe(true);
    expect(btn3?.textContent).toBe('Enriching...');
    expect(btn3?.title).toBe('Enrichment in progress');

    expect(btn4?.disabled).toBe(true);
    expect(btn4?.textContent).toBe('Enriching...');
    expect(btn4?.title).toBe('Enrichment in progress');

    expect(btn5?.disabled).toBe(false);
    expect(btn5?.textContent).toBe('Enrich');

    expect(btn6?.disabled).toBe(false);
    expect(btn6?.textContent).toBe('Enrich');

    btn2?.click();
    btn3?.click();
    btn4?.click();
    expect(onEnrichSingleJob).not.toHaveBeenCalled();

    btn1?.click();
    expect(onEnrichSingleJob).toHaveBeenCalledTimes(1);
    expect(onEnrichSingleJob).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
  });
});
