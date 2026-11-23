import {
  type ColumnDef,
  type ColumnFiltersState,
  createColumnHelper,
  createTable,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type PaginationState,
  type Row,
  type RowSelectionState,
  type SortingState,
  type Table,
  type TableState,
} from '@tanstack/table-core';
import type { PortfolioReferenceEntry, SavedJob } from '../types';
import { escapeHtml, getTimeAgo, sanitizeHttpUrl } from '../utils';

export interface EnrichmentBadgeInfo {
  key:
    | 'none'
    | 'detail_only'
    | 'queued'
    | 'scraping_details'
    | 'analyzing'
    | 'completed'
    | 'failed';
  label: string;
  tone: 'muted' | 'neutral' | 'info' | 'success' | 'danger';
  tooltip: string;
}

export function getEffectiveEnrichmentState(job: SavedJob): EnrichmentBadgeInfo {
  const status = (job.ai_enrichment_status ?? 'none').toLowerCase();
  if (status === 'queued') {
    return { key: 'queued', label: 'Queued', tone: 'info', tooltip: 'Queued for AI enrichment' };
  }
  if (status === 'scraping_details') {
    return {
      key: 'scraping_details',
      label: 'Scraping Details...',
      tone: 'info',
      tooltip: 'Fetching full Upwork job details via Chrome',
    };
  }
  if (status === 'analyzing') {
    return {
      key: 'analyzing',
      label: 'Analyzing...',
      tone: 'info',
      tooltip: 'Running AI analysis',
    };
  }
  if (status === 'failed') {
    return {
      key: 'failed',
      label: 'Failed',
      tone: 'danger',
      tooltip: job.ai_enrichment_error || 'Enrichment failed',
    };
  }
  if (status === 'completed' || job.ai_enriched_at || job.proposal?.trim()) {
    const parts: string[] = [];
    if (job.ai_model) parts.push(job.ai_model);
    if (job.ai_effort) parts.push(`effort: ${job.ai_effort}`);
    if (typeof job.ai_tokens_used === 'number' && Number.isFinite(job.ai_tokens_used)) {
      parts.push(`${job.ai_tokens_used} tokens`);
    }
    return {
      key: 'completed',
      label: 'AI Enriched ✓',
      tone: 'success',
      tooltip: parts.length > 0 ? parts.join(' · ') : 'AI analysis complete',
    };
  }
  if (job.last_enriched_at) {
    return {
      key: 'detail_only',
      label: 'Details Only',
      tone: 'neutral',
      tooltip: 'Full job details fetched (0 LLM tokens)',
    };
  }
  return {
    key: 'none',
    label: 'Unenriched',
    tone: 'muted',
    tooltip: 'Not yet AI-enriched',
  };
}

export function isJobAiEnriched(job: SavedJob): boolean {
  return getEffectiveEnrichmentState(job).key === 'completed';
}

function parseMoneyNumbers(raw?: string | null): number[] {
  if (!raw) return [];
  const dollarMatches = raw.match(/\$\s*[\d,]+(?:\.\d+)?/g);
  const tokens = dollarMatches ?? raw.replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  if (!tokens) return [];
  return tokens
    .map((m) => Number.parseFloat(m.replace(/[$,\s]/g, '')))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/**
 * Extracts a deterministic numeric value for sorting fixed budgets and hourly rates.
 * Handles formats like "$2,200.00", "$1,500.00", "$80-$120/hr", "$8,000.00 fixed".
 */
export function parseNumericBudget(job: SavedJob): number | undefined {
  const candidates =
    job.contract_type === 'fixed'
      ? [job.budget_amount, job.budget]
      : job.contract_type === 'hourly'
        ? [job.rate_max, job.rate_range, job.rate_min, job.budget]
        : [job.budget_amount, job.rate_max, job.budget, job.rate_range, job.rate_min];

  for (const raw of candidates) {
    const nums = parseMoneyNumbers(raw);
    if (nums.length > 0) {
      return Math.max(...nums);
    }
  }
  return undefined;
}

function formatBudgetDisplay(job: SavedJob): string {
  if (job.budget?.trim()) return job.budget.trim();
  if (job.budget_amount?.trim()) return job.budget_amount.trim();
  if (job.rate_range?.trim()) return job.rate_range.trim();
  if (job.rate_min?.trim() || job.rate_max?.trim()) {
    return [job.rate_min, job.rate_max].filter(Boolean).join(' - ');
  }
  return 'N/A';
}

export interface MatchedProjectBadge {
  label: string;
  isNda: boolean;
}

export function getMatchedProjectBadges(
  job: SavedJob,
  anonymizedLabels?: ReadonlySet<string>,
): MatchedProjectBadge[] {
  const seen = new Set<string>();
  const badges: MatchedProjectBadge[] = [];

  if (Array.isArray(job.portfolio_references)) {
    for (const rawRef of job.portfolio_references) {
      const ref = rawRef as PortfolioReferenceEntry & { title?: string };
      if (ref.source !== 'active_project') continue;
      const label = ref.display_name?.trim() || ref.title?.trim() || '';
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      badges.push({
        label,
        isNda: ref.visibility !== 'public',
      });
    }
  }

  const matched = job.score_breakdown?.matched_active_projects;
  if (Array.isArray(matched)) {
    for (const item of matched) {
      if (typeof item !== 'string') continue;
      const label = item.trim();
      if (!label || seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      badges.push({
        label,
        isNda: Boolean(anonymizedLabels?.has(label.toLowerCase())),
      });
    }
  }

  return badges;
}

function parseJobPostedEpoch(job: SavedJob): number {
  const raw = job.posted_at_est ?? job.created_at;
  if (!raw) return 0;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : 0;
}

function formatPostedCell(job: SavedJob): string {
  if (job.posted_text?.trim()) return job.posted_text.trim();
  const raw = job.posted_at_est ?? job.created_at;
  if (!raw) return '--';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '--';
  return getTimeAgo(d);
}

export interface JobsTableCallbacks {
  onInspectJob: (job: SavedJob) => void;
  onEnrichSingleJob: (job: SavedJob) => void;
  onStatusChange: (jobId: number, status: string) => void;
  onSelectionChange: (selectedJobs: SavedJob[]) => void;
}

export interface JobsTableOptions {
  tableWrap: HTMLElement;
  paginationWrap: HTMLElement;
  callbacks: JobsTableCallbacks;
  pageSize?: number;
}

const JOB_STATUS_OPTIONS = ['discovered', 'ready', 'applied', 'archived', 'rejected'] as const;

export class JobsTable {
  private readonly tableWrap: HTMLElement;
  private readonly paginationWrap: HTMLElement;
  private readonly callbacks: JobsTableCallbacks;

  private jobs: SavedJob[] = [];
  private anonymizedProjectLabels = new Set<string>();
  private lastSelectedRowId: string | null = null;
  private state: TableState;
  private readonly table: Table<SavedJob>;

  constructor(options: JobsTableOptions) {
    this.tableWrap = options.tableWrap;
    this.paginationWrap = options.paginationWrap;
    this.callbacks = options.callbacks;

    const initialPageSize = options.pageSize ?? 50;
    this.state = {
      columnVisibility: {},
      columnOrder: [],
      columnPinning: { left: [], right: [] },
      rowPinning: { top: [], bottom: [] },
      columnFilters: [],
      globalFilter: '',
      sorting: [],
      expanded: {},
      grouping: [],
      columnSizing: {},
      columnSizingInfo: {
        startOffset: null,
        startSize: null,
        deltaOffset: null,
        deltaPercentage: null,
        isResizingColumn: false,
        columnSizingStart: [],
      },
      pagination: { pageIndex: 0, pageSize: initialPageSize },
      rowSelection: {},
    };

    const columnHelper = createColumnHelper<SavedJob>();
    const columns: ColumnDef<SavedJob, unknown>[] = [
      columnHelper.display({
        id: 'select',
        header: () => '',
        enableSorting: false,
      }),
      columnHelper.accessor((row) => row.job_title ?? '', {
        id: 'job_title',
        header: 'Job Title',
      }) as ColumnDef<SavedJob, unknown>,
      columnHelper.accessor(
        (row) => (typeof row.score === 'number' && Number.isFinite(row.score) ? row.score : -1),
        {
          id: 'score',
          header: 'Score',
        },
      ) as ColumnDef<SavedJob, unknown>,
      columnHelper.accessor((row) => parseNumericBudget(row), {
        id: 'budget',
        header: 'Budget / Rate',
        sortUndefined: 'last',
      }) as ColumnDef<SavedJob, unknown>,
      columnHelper.accessor(
        (row) =>
          getMatchedProjectBadges(row, this.anonymizedProjectLabels)
            .map((b) => b.label)
            .join(', '),
        {
          id: 'matched_projects',
          header: 'Matched Projects',
        },
      ) as ColumnDef<SavedJob, unknown>,
      columnHelper.accessor((row) => row.client_spent_usd ?? -1, {
        id: 'client_signals',
        header: 'Client Signals',
      }) as ColumnDef<SavedJob, unknown>,
      columnHelper.accessor((row) => parseJobPostedEpoch(row), {
        id: 'posted',
        header: 'Posted',
      }) as ColumnDef<SavedJob, unknown>,
      columnHelper.accessor((row) => getEffectiveEnrichmentState(row).key, {
        id: 'enrichment_state',
        header: 'Enrichment',
      }) as ColumnDef<SavedJob, unknown>,
      columnHelper.display({
        id: 'actions',
        header: 'Actions',
        enableSorting: false,
      }),
    ];

    this.table = createTable<SavedJob>({
      data: this.jobs,
      columns,
      state: this.state,
      renderFallbackValue: null,
      enableRowSelection: true,
      autoResetPageIndex: false,
      getRowId: (row) => String(row.id),
      getCoreRowModel: getCoreRowModel(),
      getSortedRowModel: getSortedRowModel(),
      getFilteredRowModel: getFilteredRowModel(),
      getPaginationRowModel: getPaginationRowModel(),
      onStateChange: (updater) => {
        const prevSelection = this.state.rowSelection;
        this.state = typeof updater === 'function' ? updater(this.state) : updater;
        this.table.setOptions((prev) => ({
          ...prev,
          state: this.state,
        }));
        this.render();
        if (prevSelection !== this.state.rowSelection) {
          this.callbacks.onSelectionChange(this.getSelectedJobs());
        }
      },
      globalFilterFn: (row, _columnId, filterValue) => {
        const q = String(filterValue ?? '')
          .trim()
          .toLowerCase();
        if (!q) return true;
        const job = row.original;
        const haystack = [
          job.job_title,
          job.job_description,
          job.skills,
          job.source_query,
          job.client_country,
          getMatchedProjectBadges(job, this.anonymizedProjectLabels)
            .map((b) => b.label)
            .join(' '),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return haystack.includes(q);
      },
    });

    this.bindEvents();
    this.render();
  }

  setAnonymizedProjectLabels(labels: Iterable<string>): void {
    this.anonymizedProjectLabels = new Set(Array.from(labels, (l) => l.trim().toLowerCase()));
    this.render();
  }

  setJobs(jobs: SavedJob[]): void {
    this.jobs = jobs;
    this.table.setOptions((prev) => ({
      ...prev,
      data: this.jobs,
    }));
    // Prune rowSelection keys no longer in dataset if dataset shrunk cleanly?
    // Keeping existing IDs that remain in dataset is automatic via getRowId.
    const validIds = new Set(jobs.map((j) => String(j.id)));
    const nextSelection: RowSelectionState = {};
    let changed = false;
    for (const [id, val] of Object.entries(this.state.rowSelection)) {
      if (val && validIds.has(id)) {
        nextSelection[id] = true;
      } else if (val) {
        changed = true;
      }
    }
    if (this.lastSelectedRowId !== null && !validIds.has(this.lastSelectedRowId)) {
      this.lastSelectedRowId = null;
    }
    const maxPageIndex = Math.max(0, this.table.getPageCount() - 1);
    const nextPageIndex = Math.min(this.state.pagination.pageIndex, maxPageIndex);
    if (changed || nextPageIndex !== this.state.pagination.pageIndex) {
      this.state = {
        ...this.state,
        ...(changed ? { rowSelection: nextSelection } : {}),
        ...(nextPageIndex !== this.state.pagination.pageIndex
          ? { pagination: { ...this.state.pagination, pageIndex: nextPageIndex } }
          : {}),
      };
      this.table.setOptions((prev) => ({ ...prev, state: this.state }));
    }
    this.render();
    if (changed) {
      this.callbacks.onSelectionChange(this.getSelectedJobs());
    }
  }

  setGlobalFilter(query: string): void {
    if (this.state.globalFilter === query) return;
    this.table.setState((prev) => ({
      ...prev,
      globalFilter: query,
      pagination: { ...prev.pagination, pageIndex: 0 },
    }));
  }

  setColumnFilters(filters: ColumnFiltersState): void {
    if (JSON.stringify(this.state.columnFilters) === JSON.stringify(filters)) return;
    this.table.setState((prev) => ({
      ...prev,
      columnFilters: filters,
      pagination: { ...prev.pagination, pageIndex: 0 },
    }));
  }

  setSorting(sorting: SortingState): void {
    this.table.setState((prev) => ({
      ...prev,
      sorting,
    }));
  }

  setPagination(pagination: PaginationState): void {
    this.table.setState((prev) => ({
      ...prev,
      pagination,
    }));
  }

  getSelectedJobs(): SavedJob[] {
    const selectedMap = this.state.rowSelection;
    return this.jobs.filter((j) => Boolean(selectedMap[String(j.id)]));
  }

  getSelectedJobIds(): number[] {
    return this.getSelectedJobs().map((j) => j.id);
  }

  selectAllMatching(): void {
    const filteredRows = this.table.getFilteredRowModel().rows;
    const nextSelection: RowSelectionState = { ...this.state.rowSelection };
    for (const row of filteredRows) {
      nextSelection[row.id] = true;
    }
    this.table.setRowSelection(nextSelection);
  }

  clearSelection(): void {
    this.lastSelectedRowId = null;
    this.table.setRowSelection({});
  }

  getVisibleRows(): Row<SavedJob>[] {
    return this.table.getRowModel().rows;
  }

  getFilteredRowCount(): number {
    return this.table.getFilteredRowModel().rows.length;
  }

  private bindEvents(): void {
    this.tableWrap.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      const selectAllCheckbox = target.closest<HTMLInputElement>(
        '[data-testid="select-all-page-checkbox"]',
      );
      if (selectAllCheckbox) {
        const checked = selectAllCheckbox.checked;
        this.table.toggleAllPageRowsSelected(checked);
        return;
      }

      const rowCheckbox = target.closest<HTMLInputElement>('.dash-row-checkbox');
      if (rowCheckbox) {
        const rowId = rowCheckbox.dataset.jobId;
        if (!rowId) return;
        const checked = rowCheckbox.checked;
        const prePaginationRows = this.table.getPrePaginationRowModel().rows;
        const targetIdx = prePaginationRows.findIndex((r) => r.id === rowId);
        const anchorIdx =
          this.lastSelectedRowId !== null
            ? prePaginationRows.findIndex((r) => r.id === this.lastSelectedRowId)
            : -1;

        if (event.shiftKey && anchorIdx !== -1 && targetIdx !== -1) {
          const start = Math.min(anchorIdx, targetIdx);
          const end = Math.max(anchorIdx, targetIdx);
          const nextSelection: RowSelectionState = { ...this.state.rowSelection };
          for (let i = start; i <= end; i++) {
            const row = prePaginationRows[i];
            if (!row) continue;
            if (checked) {
              nextSelection[row.id] = true;
            } else {
              delete nextSelection[row.id];
            }
          }
          this.lastSelectedRowId = rowId;
          this.table.setRowSelection(nextSelection);
          return;
        }

        this.lastSelectedRowId = rowId;
        const nextSelection: RowSelectionState = { ...this.state.rowSelection };
        if (checked) {
          nextSelection[rowId] = true;
        } else {
          delete nextSelection[rowId];
        }
        this.table.setRowSelection(nextSelection);
        return;
      }

      const sortHeader = target.closest<HTMLElement>('th[data-sortable="true"]');
      if (sortHeader) {
        const colId = sortHeader.dataset.colId;
        if (colId) {
          const column = this.table.getColumn(colId);
          column?.toggleSorting();
        }
        return;
      }

      const inspectBtn = target.closest<HTMLElement>('.dash-job-title-btn, .js-row-inspect');
      if (inspectBtn) {
        const idNum = Number.parseInt(inspectBtn.dataset.jobId ?? '', 10);
        const job = this.jobs.find((j) => j.id === idNum);
        if (job) {
          this.callbacks.onInspectJob(job);
        }
        return;
      }

      const enrichBtn = target.closest<HTMLButtonElement>('.js-row-enrich');
      if (enrichBtn && !enrichBtn.disabled) {
        const idNum = Number.parseInt(enrichBtn.dataset.jobId ?? '', 10);
        const job = this.jobs.find((j) => j.id === idNum);
        if (job) {
          this.callbacks.onEnrichSingleJob(job);
        }
      }
    });

    this.tableWrap.addEventListener('change', (event) => {
      const target = event.target as HTMLElement | null;
      const statusSelect = target?.closest<HTMLSelectElement>('.js-row-status');
      if (!statusSelect) return;
      const idNum = Number.parseInt(statusSelect.dataset.jobId ?? '', 10);
      if (Number.isFinite(idNum) && statusSelect.value) {
        this.callbacks.onStatusChange(idNum, statusSelect.value);
      }
    });

    this.paginationWrap.addEventListener('click', (event) => {
      const target = event.target as HTMLElement | null;
      const btn = target?.closest<HTMLButtonElement>('button[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      if (action === 'prev-page' && this.table.getCanPreviousPage()) {
        this.table.previousPage();
      } else if (action === 'next-page' && this.table.getCanNextPage()) {
        this.table.nextPage();
      } else if (action === 'select-all-matching') {
        this.selectAllMatching();
      } else if (action === 'clear-selection') {
        this.clearSelection();
      }
    });

    this.paginationWrap.addEventListener('change', (event) => {
      const target = event.target as HTMLSelectElement | null;
      if (target?.dataset.action === 'page-size') {
        const nextSize = Number.parseInt(target.value, 10);
        if (Number.isFinite(nextSize) && nextSize > 0) {
          this.table.setPageSize(nextSize);
        }
      }
    });
  }

  render(): void {
    const headerGroups = this.table.getHeaderGroups();
    const visibleRows = this.table.getRowModel().rows;
    const filteredCount = this.table.getFilteredRowModel().rows.length;
    const pageIndex = this.state.pagination.pageIndex;
    const pageSize = this.state.pagination.pageSize;
    const pageCount = Math.max(1, this.table.getPageCount());
    const allPageSelected = visibleRows.length > 0 && this.table.getIsAllPageRowsSelected();
    const somePageSelected = this.table.getIsSomePageRowsSelected();

    const headerHtml = headerGroups
      .map(
        (group) =>
          `<tr>${group.headers
            .map((header) => {
              const colId = header.column.id;
              if (colId === 'select') {
                return `<th class="dash-th-select" scope="col"><input type="checkbox" id="dash-select-all-page" data-testid="select-all-page-checkbox" aria-label="Select all rows on page" ${allPageSelected ? 'checked' : ''} /></th>`;
              }
              const canSort = header.column.getCanSort();
              const sorted = header.column.getIsSorted();
              const sortIndicator = sorted === 'asc' ? ' ▲' : sorted === 'desc' ? ' ▼' : '';
              const label =
                typeof header.column.columnDef.header === 'string'
                  ? header.column.columnDef.header
                  : colId;
              const testIdAttr = colId === 'budget' ? ' data-testid="budget-header"' : '';
              return `<th scope="col" class="${canSort ? 'dash-th-sortable' : ''}" data-col-id="${escapeHtml(colId)}" data-sortable="${canSort ? 'true' : 'false'}"${testIdAttr}>${escapeHtml(label)}${sortIndicator}</th>`;
            })
            .join('')}</tr>`,
      )
      .join('');

    const rowsHtml =
      visibleRows.length === 0
        ? `<tr><td colspan="9" class="dash-empty-cell">No jobs match the current filters.</td></tr>`
        : visibleRows
            .map((row, visibleIndex) => {
              const job = row.original;
              const idStr = escapeHtml(String(job.id));
              const isSelected = row.getIsSelected();
              const safeUrl = sanitizeHttpUrl(job.canonical_url ?? job.url ?? '');
              const scoreText =
                typeof job.score === 'number' && Number.isFinite(job.score)
                  ? String(Math.round(job.score))
                  : '--';
              const fit = (job.fit_label ?? '').toLowerCase();
              const fitClass =
                fit === 'hot' || fit === 'ready' || fit === 'review' || fit === 'skip'
                  ? `dash-fit-${fit}`
                  : 'dash-fit-unknown';

              const contractLabel =
                job.contract_type === 'hourly'
                  ? 'Hourly'
                  : job.contract_type === 'fixed'
                    ? 'Fixed'
                    : 'Budget';
              const budgetDisplay = formatBudgetDisplay(job);

              const projectBadges = getMatchedProjectBadges(job, this.anonymizedProjectLabels);
              const projectsHtml =
                projectBadges.length === 0
                  ? '<span class="dash-muted">—</span>'
                  : projectBadges
                      .map(
                        (b) =>
                          `<span class="dash-proj-badge ${b.isNda ? 'dash-proj-nda' : ''}">${escapeHtml(b.label)}${b.isNda ? ' <strong>[NDA]</strong>' : ''}</span>`,
                      )
                      .join(' ');

              const clientSignals: string[] = [];
              if (job.payment_verified === true) {
                clientSignals.push('<span class="dash-sig-verified">✓ Verified</span>');
              } else if (job.payment_verified === false) {
                clientSignals.push('<span class="dash-sig-unverified">Unverified</span>');
              }
              if (job.client_spent) {
                clientSignals.push(`<span>${escapeHtml(job.client_spent)}</span>`);
              }
              if (
                typeof job.client_hire_rate === 'number' &&
                Number.isFinite(job.client_hire_rate)
              ) {
                clientSignals.push(
                  `<span>${escapeHtml(String(Math.round(job.client_hire_rate)))}% hire</span>`,
                );
              }
              if (job.proposals_tier) {
                clientSignals.push(`<span>${escapeHtml(job.proposals_tier)}</span>`);
              }
              if (
                typeof job.connects_required === 'number' &&
                Number.isFinite(job.connects_required)
              ) {
                clientSignals.push(
                  `<span>${escapeHtml(String(job.connects_required))} Connects</span>`,
                );
              }
              if (job.client_country) {
                clientSignals.push(`<span>${escapeHtml(job.client_country)}</span>`);
              }

              const enrichState = getEffectiveEnrichmentState(job);
              const isEnrichInProgress =
                enrichState.key === 'queued' ||
                enrichState.key === 'scraping_details' ||
                enrichState.key === 'analyzing';
              const enrichBtnLabel =
                enrichState.key === 'queued'
                  ? 'Queued'
                  : isEnrichInProgress
                    ? 'Enriching...'
                    : 'Enrich';
              const enrichBtnAttrs = isEnrichInProgress
                ? ' disabled title="Enrichment in progress"'
                : '';
              const currentStatus = job.status ?? 'discovered';
              const statusOptions = JOB_STATUS_OPTIONS.includes(
                currentStatus as (typeof JOB_STATUS_OPTIONS)[number],
              )
                ? JOB_STATUS_OPTIONS
                : ([currentStatus, ...JOB_STATUS_OPTIONS] as const);

              return `<tr class="${isSelected ? 'dash-row-selected' : ''}" data-job-id="${idStr}">
                <td class="dash-td-select">
                  <input type="checkbox" class="dash-row-checkbox" data-testid="row-checkbox-${idStr}" data-job-id="${idStr}" data-row-index="${visibleIndex}" aria-label="Select ${escapeHtml(job.job_title || 'job')}" ${isSelected ? 'checked' : ''} />
                </td>
                <td class="dash-td-title">
                  <div class="dash-title-row">
                    <button type="button" class="dash-job-title-btn" data-testid="row-title-btn-${idStr}" data-job-id="${idStr}">${escapeHtml(job.job_title || 'Untitled Job')}</button>
                    ${safeUrl ? `<a class="dash-ext-link" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" title="Open on Upwork">↗</a>` : ''}
                  </div>
                  <div class="dash-subtitle">
                    ${job.source_query ? `<span>q: ${escapeHtml(job.source_query)}</span>` : ''}
                    ${job.source_feed ? `<span>${escapeHtml(job.source_feed)}</span>` : ''}
                    ${job.experience_level ? `<span>${escapeHtml(job.experience_level)}</span>` : ''}
                  </div>
                </td>
                <td class="dash-td-score">
                  <span class="dash-score-pill ${fitClass}">${escapeHtml(scoreText)}${fit ? ` ${escapeHtml(fit)}` : ''}</span>
                </td>
                <td class="dash-td-budget">
                  <div class="dash-budget-type">${escapeHtml(contractLabel)}</div>
                  <div class="dash-budget-val">${escapeHtml(budgetDisplay)}</div>
                </td>
                <td class="dash-td-projects">${projectsHtml}</td>
                <td class="dash-td-signals"><div class="dash-signals-wrap">${clientSignals.join(' · ') || '<span class="dash-muted">—</span>'}</div></td>
                <td class="dash-td-posted">${escapeHtml(formatPostedCell(job))}</td>
                <td class="dash-td-enrich">
                  <span class="dash-enrich-badge dash-enrich-${enrichState.tone}" data-testid="enrichment-badge-${idStr}" title="${escapeHtml(enrichState.tooltip)}">${escapeHtml(enrichState.label)}</span>
                </td>
                <td class="dash-td-actions">
                  <div class="dash-row-actions">
                    <button type="button" class="dash-btn-sm js-row-inspect" data-testid="row-inspect-btn-${idStr}" data-job-id="${idStr}">Inspect</button>
                    <button type="button" class="dash-btn-sm dash-btn-accent js-row-enrich" data-testid="row-enrich-btn-${idStr}" data-job-id="${idStr}"${enrichBtnAttrs}>${enrichBtnLabel}</button>
                    <select class="dash-status-select js-row-status" data-testid="row-status-select-${idStr}" data-job-id="${idStr}" aria-label="Status for ${escapeHtml(job.job_title || 'job')}">
                      ${statusOptions
                        .map(
                          (opt) =>
                            `<option value="${escapeHtml(opt)}" ${opt === currentStatus ? 'selected' : ''}>${escapeHtml(opt)}</option>`,
                        )
                        .join('')}
                    </select>
                  </div>
                </td>
              </tr>`;
            })
            .join('');

    this.tableWrap.innerHTML = `
      <div class="dash-table-scroller">
        <table class="dash-table" data-testid="jobs-table">
          <thead>${headerHtml}</thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;

    const headerCb = this.tableWrap.querySelector<HTMLInputElement>('#dash-select-all-page');
    if (headerCb) {
      headerCb.indeterminate = somePageSelected && !allPageSelected;
    }

    const selectedCount = this.getSelectedJobIds().length;
    this.paginationWrap.innerHTML = `
      <div class="dash-pagination-bar">
        <div class="dash-pagination-left">
          <span class="dash-muted">${filteredCount} matching job${filteredCount === 1 ? '' : 's'}</span>
          ${
            filteredCount > 0
              ? `<button type="button" class="dash-btn-sm" data-action="select-all-matching" data-testid="select-all-matching-btn">Select all matching (${filteredCount})</button>`
              : ''
          }
          ${
            selectedCount > 0
              ? `<button type="button" class="dash-btn-sm" data-action="clear-selection" data-testid="clear-selection-btn">Clear selection (${selectedCount})</button>`
              : ''
          }
        </div>
        <div class="dash-pagination-right">
          <label class="dash-page-size-label">
            Rows:
            <select data-action="page-size" data-testid="page-size-select">
              ${[25, 50, 100]
                .map(
                  (sz) =>
                    `<option value="${sz}" ${pageSize === sz ? 'selected' : ''}>${sz}</option>`,
                )
                .join('')}
            </select>
          </label>
          <button type="button" class="dash-btn-sm" data-action="prev-page" ${this.table.getCanPreviousPage() ? '' : 'disabled'}>Prev</button>
          <span class="dash-page-info">Page ${pageIndex + 1} of ${pageCount}</span>
          <button type="button" class="dash-btn-sm" data-action="next-page" ${this.table.getCanNextPage() ? '' : 'disabled'}>Next</button>
        </div>
      </div>
    `;
  }
}
