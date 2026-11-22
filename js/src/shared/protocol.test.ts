import { describe, expect, it } from 'vitest';
import {
  BackgroundCommandMessageSchema,
  BridgeErrorCodeSchema,
  KillSwitchAbortResultSchema,
  SessionStatusResultSchema,
  TabsListResultSchema,
  WsAuthRequestSchema,
  WsAuthSuccessResponseSchema,
  WsPingSchema,
  WsPongSchema,
  WsRpcRequestSchema,
  WsTaskProgressSchema,
} from './protocol';
import {
  ExtensionSettingsSchema,
  JobUpsertPayloadSchema,
  MessageItemSchema,
  MessageThreadSchema,
  ProposalDraftSchema,
  SearchRunFiltersSchema,
  SearchRunRequestSchema,
} from './schemas';
import { BUNDLED_SELECTORS, SelectorConfigSchema } from './selectors';

describe('M3 Shared Zod v4 Protocol & Schemas', () => {
  it('validates BUNDLED_SELECTORS against SelectorConfigSchema', () => {
    const parsed = SelectorConfigSchema.safeParse(BUNDLED_SELECTORS);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.version).toBe('2.0');
      expect(Object.keys(parsed.data.views)).toEqual(
        expect.arrayContaining([
          'search_listings',
          'best_matches',
          'most_recent',
          'saved_jobs',
          'job_detail',
          'proposal_apply',
          'proposals_list',
          'messages_rooms',
          'messages_thread',
        ]),
      );
    }
  });

  it('validates WS JSON-RPC auth, ping/pong, progress, and RPC result envelopes', () => {
    expect(
      WsAuthRequestSchema.safeParse({
        jsonrpc: '2.0',
        id: 'auth-1',
        method: 'auth',
        params: { token: 'abc', extension_version: '2.0.0', browser: 'chrome' },
      }).success,
    ).toBe(true);

    expect(
      WsAuthSuccessResponseSchema.safeParse({
        jsonrpc: '2.0',
        id: 'auth-1',
        result: { ok: true, session_id: 'ext-1234' },
      }).success,
    ).toBe(true);

    expect(WsPingSchema.safeParse({ jsonrpc: '2.0', method: 'ping' }).success).toBe(true);
    expect(WsPongSchema.safeParse({ jsonrpc: '2.0', method: 'pong' }).success).toBe(true);
    expect(
      WsTaskProgressSchema.safeParse({
        jsonrpc: '2.0',
        method: 'task.progress',
        params: { request_id: 'rpc-1', stage: 'enrich', current: 2, total: 5 },
      }).success,
    ).toBe(true);

    expect(
      SessionStatusResultSchema.safeParse({
        ok: true,
        extension_connected: true,
        extension_version: '2.0.0',
        browser: 'chrome',
        upwork_logged_in: true,
        automation_tab_id: 42,
        busy: false,
        active_request_id: null,
        kill_switch_active: false,
        last_error: null,
      }).success,
    ).toBe(true);

    expect(
      TabsListResultSchema.safeParse({
        tabs: [
          {
            id: 1,
            title: 'Upwork',
            url: 'https://www.upwork.com/nx/search/jobs/',
            active: true,
            automation: false,
            is_automation: false,
          },
        ],
      }).success,
    ).toBe(true);

    expect(
      KillSwitchAbortResultSchema.safeParse({
        aborted: true,
        active_request_id: 'rpc-9',
        reason: 'User triggered kill switch',
      }).success,
    ).toBe(true);
  });

  it('rejects malformed JSON-RPC frames and invalid error codes', () => {
    expect(
      WsAuthRequestSchema.safeParse({
        jsonrpc: '1.0',
        id: 'auth-1',
        method: 'auth',
        params: { token: '', extension_version: '2.0.0', browser: 'chrome' },
      }).success,
    ).toBe(false);

    expect(
      WsRpcRequestSchema.safeParse({
        jsonrpc: '2.0',
        id: null,
        method: '',
      }).success,
    ).toBe(false);

    expect(BridgeErrorCodeSchema.safeParse('HUMAN_ACTION_REQUIRED').success).toBe(true);
    expect(BridgeErrorCodeSchema.safeParse('UNKNOWN_FAKE_CODE').success).toBe(false);
  });

  it('validates domain schemas and background command union', () => {
    expect(
      JobUpsertPayloadSchema.safeParse({
        job_title: 'Go Developer',
        url: 'https://www.upwork.com/jobs/~022115332344639171/',
        skills: ['Go', 'PostgreSQL'],
      }).success,
    ).toBe(true);

    expect(
      ProposalDraftSchema.safeParse({
        upwork_job_id: '~022115332344639171',
        cover_letter: 'Hello',
        bid_type: 'fixed',
        bid_amount: 1200,
        status: 'pending_approval',
      }).success,
    ).toBe(true);

    expect(
      MessageThreadSchema.safeParse({
        upwork_room_id: 'room-1',
        client_name: 'Alice',
        unread_count: 2,
        last_message_snippet: 'Hi there',
      }).success,
    ).toBe(true);

    expect(
      MessageItemSchema.safeParse({
        sender: 'Alice',
        sender_role: 'client',
        body: 'Can we start Monday?',
        status: 'received',
      }).success,
    ).toBe(true);

    expect(
      ExtensionSettingsSchema.safeParse({
        apiBaseUrl: 'http://127.0.0.1:9090',
        apiToken: 'tok-123',
        pacingSeconds: 4.5,
        jitterRatio: 0.5,
      }).success,
    ).toBe(true);

    expect(
      BackgroundCommandMessageSchema.safeParse({
        type: 'PAIR_AND_RECONNECT',
        apiBaseUrl: 'http://127.0.0.1:9090',
        apiToken: 'tok-123',
      }).success,
    ).toBe(true);
  });

  it('validates M2 SearchRunFiltersSchema and SearchRunRequestSchema criteria and bounds', () => {
    expect(
      SearchRunFiltersSchema.safeParse({
        hourly_rate_min: 60,
        hourly_rate_max: 120,
        payment_verified_only: true,
      }).success,
    ).toBe(true);

    expect(
      SearchRunFiltersSchema.safeParse({
        hourly_rate_min: 120,
        hourly_rate_max: 60,
      }).success,
    ).toBe(false);

    const parsed = SearchRunRequestSchema.safeParse({
      queries: ['Go PostgreSQL'],
      hourly_rate_min: 0,
      hourly_rate_max: 95.5,
      payment_verified_only: true,
      run_label: 'Nightly sweep',
      skip_auto_detail_enrich: true,
      from_active_projects: true,
      active_project_keys: ['upwork-buddy'],
      active_project_tiers: ['active', 'recent'],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.run_label).toBe('Nightly sweep');
      expect(parsed.data.skip_auto_detail_enrich).toBe(true);
      expect(parsed.data.from_active_projects).toBe(true);
      expect(parsed.data.active_project_keys).toEqual(['upwork-buddy']);
      expect(parsed.data.active_project_tiers).toEqual(['active', 'recent']);
    }

    expect(
      SearchRunRequestSchema.safeParse({
        hourly_rate_min: -5,
      }).success,
    ).toBe(false);

    expect(
      SearchRunRequestSchema.safeParse({
        hourly_rate_min: 100,
        hourly_rate_max: 50,
      }).success,
    ).toBe(false);
  });
});
