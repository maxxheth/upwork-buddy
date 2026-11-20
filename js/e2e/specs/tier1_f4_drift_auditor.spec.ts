import { parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface BaselineDiffItem {
  change_type?: string;
  change?: string;
  type?: string;
  hook?: string;
  key?: string;
  previous_frequency?: number;
  current_frequency?: number;
}

interface SelectorAuditReport {
  view_type: string;
  overall_status?: string;
  total_cards_detected: number;
  rules?: Record<string, { status: string; suggested_replacement?: string }>;
  field_results?: Array<{ field: string; status: string; suggested_replacement?: string }>;
  discovered_candidates?: Array<{
    attribute?: string;
    key?: string;
    selector?: string;
    confidence: string;
  }>;
  baseline_diff?: BaselineDiffItem[];
  baseline_diffs?: BaselineDiffItem[];
}

test.describe('Tier 1 F4 — UI Drift Auditor & Selector Health', () => {
  test('T1-F4-01: GET /api/selectors contract delivery & extension loading on Upwork page', async ({
    pairedExtension,
    daemon,
    upworkPage,
  }) => {
    const res = await daemon.apiFetch('/api/selectors');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      page_guards: Record<string, unknown>;
      auth_and_challenge_guards: Record<string, unknown>;
      views: Record<string, unknown>;
    };

    expect(body.page_guards).toBeDefined();
    expect(body.auth_and_challenge_guards).toBeDefined();

    const expectedViews = [
      'search_listings',
      'best_matches',
      'most_recent',
      'saved_jobs',
      'job_detail',
      'proposal_apply',
      'proposals_list',
      'messages_rooms',
      'messages_thread',
    ];
    for (const viewName of expectedViews) {
      expect(body.views[viewName]).toBeDefined();
    }

    await upworkPage.goto('https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1', {
      waitUntil: 'domcontentloaded',
    });
    expect(pairedExtension.errors).toEqual([]);
  });

  test('T1-F4-02: live upwork_audit_selectors on healthy search_listings & selector_audits persistence', async ({
    pairedExtension,
    daemon,
    mcpHttp,
    upworkPage,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    await upworkPage.goto('https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1', {
      waitUntil: 'domcontentloaded',
    });

    const auditRes = await mcpHttp.callTool('upwork_audit_selectors', {
      view: 'search_listings',
      url: 'https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1',
    });
    expect(auditRes.isError).not.toBe(true);
    const report = parseMcpToolJson<SelectorAuditReport>(auditRes);

    expect(report.view_type).toBe('search_listings');
    expect(report.total_cards_detected).toBeGreaterThan(0);

    const healthyFields = [
      'title',
      'url',
      'description',
      'budget',
      'hourly_rate',
      'experience_level',
      'duration',
      'skills',
      'country',
      'proposals',
      'client_rating',
    ];
    for (const field of healthyFields) {
      const ruleStatus =
        report.rules?.[field]?.status ??
        report.field_results?.find((f) => f.field === field)?.status;
      expect(ruleStatus).toBe('HEALTHY');
    }

    const auditsRes = await daemon.apiFetch('/api/selector-audits');
    expect(auditsRes.status).toBe(200);
    const { audits } = (await auditsRes.json()) as {
      audits: Array<{ view_type: string; overall_status: string }>;
    };
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect(audits[0].view_type).toBe('search_listings');
  });

  test('T1-F4-03: unmapped authenticated field discovery (HIGH & MEDIUM confidence candidates)', async ({
    pairedExtension,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const auditRes = await mcpHttp.callTool('upwork_audit_selectors', {
      view: 'search_listings',
      url: 'https://www.upwork.com/nx/search/jobs/?q=mutated_drift',
    });
    expect(auditRes.isError).not.toBe(true);
    const report = parseMcpToolJson<SelectorAuditReport>(auditRes);

    const candidates = report.discovered_candidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(15);

    const paymentBadge = candidates.find((c) =>
      JSON.stringify(c).includes('payment-verified-badge'),
    );
    expect(paymentBadge).toBeDefined();
    expect(paymentBadge?.confidence).toBe('HIGH');

    const connectsBadge = candidates.find((c) => JSON.stringify(c).includes('connects-badge'));
    expect(connectsBadge).toBeDefined();
    expect(connectsBadge?.confidence).toBe('MEDIUM');
  });

  test('T1-F4-04: baseline storage & ADDED diff detection across mutated_drift', async ({
    pairedExtension,
    mcpHttp,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    const baselineRes = await mcpHttp.callTool('upwork_audit_selectors', {
      view: 'search_listings',
      url: 'https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1',
      save_baseline: true,
    });
    expect(baselineRes.isError).not.toBe(true);

    const mutatedRes = await mcpHttp.callTool('upwork_audit_selectors', {
      view: 'search_listings',
      url: 'https://www.upwork.com/nx/search/jobs/?q=mutated_drift',
    });
    expect(mutatedRes.isError).not.toBe(true);
    const report = parseMcpToolJson<SelectorAuditReport>(mutatedRes);

    const diffs = report.baseline_diff ?? report.baseline_diffs ?? [];
    const addedMatch = diffs.find((d) => {
      const serialized = JSON.stringify(d);
      const change = d.change_type ?? d.change ?? d.type;
      return change === 'ADDED' && serialized.includes('ai-match-badge');
    });
    expect(addedMatch).toBeDefined();
    expect(addedMatch?.current_frequency ?? 0).toBeGreaterThanOrEqual(2);
  });

  test('T1-F4-05: Side Panel Selector Health UI rendering & non-Upwork tab suppression', async ({
    pairedExtension,
    extPages,
    mcpHttp,
    mockServer,
    upworkPage,
  }) => {
    const auditRes = await mcpHttp.callTool('upwork_audit_selectors', {
      view: 'search_listings',
      url: 'https://www.upwork.com/nx/search/jobs/?q=WordPress&page=1',
    });
    expect(auditRes.isError).not.toBe(true);

    await upworkPage.goto(`${mockServer.baseUrl}/non-upwork`, {
      waitUntil: 'domcontentloaded',
    });
    expect(pairedExtension.errors).toEqual([]);

    const sidePanel = await extPages.openSidePanel();
    try {
      const selectorTab = sidePanel
        .getByRole('tab', { name: /selector/i })
        .or(sidePanel.getByRole('button', { name: /selector/i }))
        .first();
      await selectorTab.click();

      await expect(sidePanel.getByText(/search_listings/i).first()).toBeVisible({
        timeout: 10_000,
      });
      await expect(sidePanel.getByText(/HEALTHY|FRAGILE/i).first()).toBeVisible();
    } finally {
      await sidePanel.close();
    }
  });
});
