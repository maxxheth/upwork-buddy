import { parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface RuleAuditResult {
  field: string;
  status: 'HEALTHY' | 'DEGRADED' | 'BROKEN' | 'FRAGILE';
  matched_count?: number;
  suggested_replacement?: string;
  reason?: string;
}

interface BaselineDiffItem {
  hook?: string;
  key?: string;
  change?: string;
  change_type?: string;
  type?: string;
  previous_frequency?: number;
  current_frequency?: number;
}

interface DriftAuditReport {
  view_type: string;
  overall_status: string;
  total_cards_detected?: number;
  rules: Record<string, RuleAuditResult> | RuleAuditResult[];
  baseline_diff?: BaselineDiffItem[];
  baseline_diffs?: BaselineDiffItem[];
  breaking_changes_detected?: boolean;
}

function getRule(report: DriftAuditReport, fieldName: string): RuleAuditResult | undefined {
  if (Array.isArray(report.rules)) {
    return report.rules.find((r) => r.field === fieldName);
  }
  return report.rules[fieldName];
}

test.describe('Tier 2 — F4: UI Drift Auditor & Selector Health', () => {
  test('T2-F4-01: FRAGILE classification when fragile primary selector matches > 0', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    upworkPage,
  }) => {
    await upworkPage.goto('https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1', {
      waitUntil: 'domcontentloaded',
    });

    const searchAudit = parseMcpToolJson<DriftAuditReport>(
      await mcpHttp.callTool('upwork_audit_selectors', {
        view: 'search_listings',
        url: 'https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1',
      }),
    );
    const postedRule = getRule(searchAudit, 'posted');
    expect(postedRule).toBeDefined();
    expect(postedRule?.status).toBe('FRAGILE');
    expect(postedRule?.suggested_replacement ?? '').toContain('job-published-date');

    await upworkPage.goto('https://www.upwork.com/jobs/~022115332344639171/', {
      waitUntil: 'domcontentloaded',
    });

    const detailAudit = parseMcpToolJson<DriftAuditReport>(
      await mcpHttp.callTool('upwork_audit_selectors', {
        view: 'job_detail',
        url: 'https://www.upwork.com/jobs/~022115332344639171/',
      }),
    );
    const skillsRule = getRule(detailAudit, 'skills');
    expect(skillsRule).toBeDefined();
    expect(skillsRule?.status).toBe('FRAGILE');
    expect(skillsRule?.suggested_replacement ?? '').toContain('.skills-list .air3-line-clamp');
  });

  test('T2-F4-02: BROKEN classification when fragile primary matches 0 (skips fallback) & when all miss', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
  }) => {
    await mockClient.configure({ driftMode: 'broken_missing' });

    const report = parseMcpToolJson<DriftAuditReport>(
      await mcpHttp.callTool('upwork_audit_selectors', {
        view: 'search_listings',
        url: 'https://www.upwork.com/nx/search/jobs/?q=mutated_drift',
      }),
    );

    const postedRule = getRule(report, 'posted');
    expect(postedRule).toBeDefined();
    expect(postedRule?.status).toBe('BROKEN');
    expect(postedRule?.suggested_replacement ?? '').toContain("[data-test='job-published-date']");

    const titleRule = getRule(report, 'title');
    expect(titleRule).toBeDefined();
    expect(titleRule?.status).toBe('BROKEN');
  });

  test('T2-F4-03: DEGRADED classification via fallback selector match', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
  }) => {
    await mockClient.configure({ driftMode: 'mutated_drift' });

    const report = parseMcpToolJson<DriftAuditReport>(
      await mcpHttp.callTool('upwork_audit_selectors', {
        view: 'search_listings',
        url: 'https://www.upwork.com/nx/search/jobs/?q=mutated_drift',
      }),
    );

    const proposalsRule = getRule(report, 'proposals');
    expect(proposalsRule).toBeDefined();
    expect(proposalsRule?.status).toBe('DEGRADED');
    expect(proposalsRule?.matched_count ?? 0).toBeGreaterThan(0);
    expect(proposalsRule?.suggested_replacement ?? '').toContain("[data-test='proposals']");
  });

  test('T2-F4-04: DEGRADED classification via empty extracted text & low card match rate', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
  }) => {
    await mockClient.configure({ driftMode: 'mutated_drift' });

    const report = parseMcpToolJson<DriftAuditReport>(
      await mcpHttp.callTool('upwork_audit_selectors', {
        view: 'search_listings',
        url: 'https://www.upwork.com/nx/search/jobs/?q=mutated_drift',
      }),
    );

    const countryRule = getRule(report, 'country');
    expect(countryRule).toBeDefined();
    expect(countryRule?.status).toBe('DEGRADED');

    const descRule = getRule(report, 'description');
    expect(descRule).toBeDefined();
    expect(descRule?.status).toBe('DEGRADED');
  });

  test('T2-F4-05: Baseline diff REMOVED & FREQUENCY_DROPPED + offline /api/selectors bundled fallback', async ({
    pairedExtension: _pairedExtension,
    mcpHttp,
    mockClient,
    daemon,
  }) => {
    // 1. Audit healthy page first to establish baseline
    const baselineReport = parseMcpToolJson<DriftAuditReport>(
      await mcpHttp.callTool('upwork_audit_selectors', {
        view: 'search_listings',
        url: 'https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1',
        save_baseline: true,
      }),
    );
    expect(baselineReport.total_cards_detected ?? 0).toBeGreaterThan(0);

    // 2. Audit mutated page and verify baseline diff detects REMOVED & FREQUENCY_DROPPED
    await mockClient.configure({ driftMode: 'mutated_drift' });
    const mutatedReport = parseMcpToolJson<DriftAuditReport>(
      await mcpHttp.callTool('upwork_audit_selectors', {
        view: 'search_listings',
        url: 'https://www.upwork.com/nx/search/jobs/?q=mutated_drift',
      }),
    );
    expect(mutatedReport.breaking_changes_detected).toBe(true);
    const diffs = mutatedReport.baseline_diff ?? mutatedReport.baseline_diffs ?? [];
    const getDiffChange = (d: BaselineDiffItem): string | undefined =>
      d.change_type ?? d.change ?? d.type;
    expect(diffs.some((d) => getDiffChange(d) === 'REMOVED')).toBe(true);
    expect(
      diffs.some(
        (d) =>
          getDiffChange(d) === 'FREQUENCY_DROPPED' && (d.hook ?? d.key ?? '').includes('token'),
      ),
    ).toBe(true);

    // 3. Corrupt worker selectors YAML so GET /api/selectors returns HTTP 500, then verify bundled fallback
    await mockClient.configure({ driftMode: 'healthy' });
    try {
      await daemon.updateSelectorsYaml(() => 'invalid_yaml: [unclosed');
      const selectorsRes = await daemon.apiFetch('/api/selectors');
      expect(selectorsRes.status).toBe(500);

      const searchRes = await mcpHttp.callTool('upwork_search_jobs', {
        source: 'search',
        query: 'WordPress',
        max_pages: 1,
      });
      expect(searchRes.isError).not.toBe(true);
      const searchPayload = parseMcpToolJson<{ jobs?: unknown[]; items?: unknown[] }>(searchRes);
      const count = (searchPayload.jobs ?? searchPayload.items ?? []).length;
      expect(count).toBeGreaterThanOrEqual(4);
    } finally {
      await daemon.restoreSelectorsYaml();
    }
  });
});
