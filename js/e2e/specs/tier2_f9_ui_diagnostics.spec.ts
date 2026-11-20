import fs from 'node:fs/promises';
import { parseMcpToolJson } from '../helpers/mcp-client.ts';
import { expect, test } from '../helpers/test-fixtures.ts';

interface DiagnosticCaptureToolOutput {
  ok: boolean;
  capture_uid: string;
  markdown: string;
  entry: {
    capture_uid: string;
    view_type: string;
    overall_status: string;
    broken_count: number;
    broken_fields: Array<{
      field: string;
      status: string;
      candidates: Array<{
        selector: string;
        stability_score: number;
        matched_count: number;
        sample_value: unknown;
      }>;
    }>;
  };
  capture?: {
    capture_uid?: string;
    view_type: string;
    broken_fields: Array<{
      field: string;
      status: string;
      candidates: Array<{
        selector: string;
        sample_value: unknown;
      }>;
    }>;
  };
  artifacts: {
    bundle_dir: string;
    snapshot_path: string;
    pruned_html_path: string;
    markdown_path: string;
  };
}

interface TestPatchToolOutput {
  ok: boolean;
  view: string;
  field: string;
  matched_count: number;
  sample_value: unknown;
  valid_yaml: boolean;
  dom_tested: boolean;
  regressions: Array<{ field: string }>;
  before_summary?: { status: string; matched_count: number };
  after_summary?: { status: string; matched_count: number; sample_value: unknown };
}

interface ApplyPatchToolOutput {
  ok: boolean;
  old_version: string;
  new_version: string;
  backup_file: string;
  reloaded_extension: boolean;
}

test.describe('Tier 2 — F9: Closed-Loop UI Diagnostics & Self-Healing Selectors', () => {
  test('T2-F9-01: Closed-loop broken skills warning -> MCP capture -> dry-run patch -> atomic apply -> live hot-reload auto-clears banner -> rollback', async ({
    pairedExtension,
    daemon,
    mockClient,
    mcpHttp,
    upworkPage,
  }) => {
    expect(pairedExtension.extensionId.length).toBeGreaterThan(0);

    try {
      await mockClient.configure({ driftMode: 'broken_detail_skills' });
      await upworkPage.goto('https://www.upwork.com/jobs/~022115332344639171/', {
        waitUntil: 'domcontentloaded',
      });

      const warningBanner = upworkPage.locator('#upwork-buddy-health-warning');
      await expect(warningBanner).toBeVisible({ timeout: 15_000 });
      await expect(warningBanner).toContainText('skills');
      await expect(warningBanner.locator('.upwork-buddy-health-diagnose')).toBeVisible();

      const captureRes = await mcpHttp.callTool('upwork_capture_ui_diagnostic', {
        use_active_tab: true,
        view: 'job_detail',
        redact_pii: true,
      });
      expect(captureRes.isError).not.toBe(true);
      const captured = parseMcpToolJson<DiagnosticCaptureToolOutput>(captureRes);
      expect(captured.ok).toBe(true);
      expect(captured.capture_uid.length).toBeGreaterThan(0);
      expect(captured.entry.view_type).toBe('job_detail');

      const brokenFields = captured.capture?.broken_fields ?? captured.entry.broken_fields;
      const skillsDiag = brokenFields.find((f) => f.field === 'skills');
      expect(skillsDiag).toBeDefined();
      expect(skillsDiag?.candidates.length).toBeGreaterThan(0);

      const mdStat = await fs.stat(captured.artifacts.markdown_path);
      expect(mdStat.size).toBeGreaterThan(50);

      const getRes = await mcpHttp.callTool('upwork_get_ui_diagnostic', {
        capture_id: 'latest',
      });
      expect(getRes.isError).not.toBe(true);
      const fetched = parseMcpToolJson<DiagnosticCaptureToolOutput>(getRes);
      expect(fetched.capture_uid).toBe(captured.capture_uid);
      expect(fetched.markdown).toContain('skills');

      const latestResource = await mcpHttp.readResource('upwork://diagnostics/latest');
      expect(latestResource.contents.length).toBeGreaterThan(0);
      const resourceJson = JSON.parse(
        latestResource.contents[0]?.text ?? '{}',
      ) as Partial<DiagnosticCaptureToolOutput>;
      expect(resourceJson.capture_uid).toBe(captured.capture_uid);

      const workingCandidate =
        skillsDiag?.candidates.find((c) => {
          const vals = Array.isArray(c.sample_value) ? c.sample_value.map(String) : [];
          return vals.includes('Go') && vals.includes('WordPress');
        })?.selector ?? '.air3-skill-chip span';

      const testRes = await mcpHttp.callTool('upwork_test_selector_patch', {
        view: 'job_detail',
        field: 'skills',
        selectors: [workingCandidate],
        extract: 'list',
      });
      expect(testRes.isError).not.toBe(true);
      const testOut = parseMcpToolJson<TestPatchToolOutput>(testRes);
      expect(testOut.ok).toBe(true);
      expect(testOut.valid_yaml).toBe(true);
      expect(testOut.dom_tested).toBe(true);
      expect(testOut.after_summary?.status).toBe('HEALTHY');
      const samples = Array.isArray(testOut.sample_value) ? testOut.sample_value.map(String) : [];
      expect(samples).toContain('Go');
      expect(samples).toContain('WordPress');
      expect(testOut.regressions).toEqual([]);

      const applyRes = await mcpHttp.callTool('upwork_apply_selector_patch', {
        view: 'job_detail',
        field: 'skills',
        selectors: [workingCandidate],
        extract: 'list',
        reason: 'E2E self-heal test',
        capture_id: captured.capture_uid,
      });
      expect(applyRes.isError).not.toBe(true);
      const applyOut = parseMcpToolJson<ApplyPatchToolOutput>(applyRes);
      expect(applyOut.ok).toBe(true);
      expect(applyOut.reloaded_extension).toBe(true);
      expect(applyOut.new_version.length).toBeGreaterThan(0);
      expect(applyOut.new_version).not.toBe(applyOut.old_version);
      expect(applyOut.backup_file.length).toBeGreaterThan(0);

      // Live selectors.reload push re-runs health check and auto-clears the banner without page reload
      await expect(warningBanner).toHaveCount(0, { timeout: 10_000 });

      const rbResp = await daemon.apiFetch('/api/diagnostics/rollback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(rbResp.status).toBe(200);
      const rbJson = (await rbResp.json()) as { ok?: boolean; version?: string };
      expect(rbJson.ok).toBe(true);
      expect(rbJson.version).toBe(applyOut.old_version);
    } finally {
      await daemon.restoreSelectorsYaml();
    }
  });
});
