import { fakeBrowser } from '@webext-core/fake-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUNDLED_SELECTORS } from '../shared/selectors';
import { unreadPollEnabledItem } from '../shared/storage-items';
import { AutomationTabController } from './tab-controller';
import {
  executeMessagesGet,
  executeMessagesList,
  executeMessagesSend,
  executeProposalFill,
  executeProposalSubmit,
  handleUnreadPollAlarm,
  pollMessagesAndSync,
  UNREAD_POLL_ALARM_NAME,
} from './workflow-rpc';
import { BridgeRpcError, HumanActionRequiredError } from './ws-client';

describe('WorkflowRpc & Unread Polling', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('navigates and re-fills if automation tab moved away before proposal.submit', async () => {
    const tabController = new AutomationTabController({
      tabMessenger: async () => ({
        ok: true,
        loggedIn: true,
        url: 'https://www.upwork.com/nx/proposals/job/~0221/apply/',
      }),
      getPacingConfig: async () => ({ pacingSeconds: 0, jitterRatio: 0 }),
    });
    const navSpy = vi.spyOn(tabController, 'navigateAndWaitForHydration').mockResolvedValue({
      tabId: 77,
      url: 'https://www.upwork.com/nx/proposals/job/~0221/apply/',
      loggedIn: true,
    });

    const sentMsgs: Array<{ type?: string }> = [];
    const deps = {
      tabController,
      proxyFetch: async () => new Response('{}', { status: 200 }),
      getSelectors: async () => BUNDLED_SELECTORS,
      getTab: async () => ({
        id: 77,
        url: 'https://www.upwork.com/nx/proposals/confirmation/990001',
      }),
      sendTabMessage: async (_tabId: number, msg: unknown) => {
        const m = msg as { type?: string };
        sentMsgs.push(m);
        if (m.type === 'CONTENT_PROPOSAL_FILL') {
          return {
            ok: true,
            snapshot: {
              cover_letter_length: 20,
              bid_type: 'fixed',
              bid_amount: 1200,
              connects_cost: 12,
              unanswered_required_questions: 0,
              screening_answers: [],
            },
          };
        }
        if (m.type === 'CONTENT_PROPOSAL_SUBMIT') {
          return {
            ok: true,
            clicked: true,
            snapshot: {
              cover_letter_length: 20,
              bid_type: 'fixed',
              bid_amount: 1200,
              connects_cost: 12,
              unanswered_required_questions: 0,
              screening_answers: [],
            },
          };
        }
        return { ok: true, loggedIn: true };
      },
    };

    await executeProposalFill(deps, {
      upwork_job_id: '~0221',
      cover_letter: 'Hello there friend!',
      bid_type: 'fixed',
      bid_amount: 1200,
    });

    // Submit when getTab returns confirmation/other URL -> navigates back to apply URL and submits
    const submitRes = await executeProposalSubmit(deps, {
      upwork_job_id: '~0221',
      cover_letter: 'Hello there friend!',
      bid_type: 'fixed',
      bid_amount: 1200,
    });

    expect(navSpy).toHaveBeenCalledTimes(2);
    expect(sentMsgs.some((m) => m.type === 'CONTENT_PROPOSAL_SUBMIT')).toBe(true);
    expect(submitRes.submitted).toBe(true);
    expect(submitRes.upwork_proposal_url).toContain('/nx/proposals/confirmation/990001');
  });

  it('propagates ROOM_NOT_FOUND and HUMAN_ACTION_REQUIRED from content adapter', async () => {
    const tabController = new AutomationTabController({
      getPacingConfig: async () => ({ pacingSeconds: 0, jitterRatio: 0 }),
    });
    vi.spyOn(tabController, 'navigateAndWaitForHydration').mockResolvedValue({
      tabId: 12,
      url: 'https://www.upwork.com/ab/messages/rooms/room_missing',
      loggedIn: true,
    });

    await expect(
      executeMessagesGet(
        {
          tabController,
          proxyFetch: async () => new Response('{}'),
          getSelectors: async () => BUNDLED_SELECTORS,
          sendTabMessage: async () => ({
            ok: false,
            errorCode: 'ROOM_NOT_FOUND',
            reason: 'Conversation not found',
          }),
        },
        { room_id: 'room_missing' },
      ),
    ).rejects.toBeInstanceOf(BridgeRpcError);

    await expect(
      executeMessagesList(
        {
          tabController,
          proxyFetch: async () => new Response('{}'),
          getSelectors: async () => BUNDLED_SELECTORS,
          sendTabMessage: async () => ({
            ok: false,
            errorCode: 'HUMAN_ACTION_REQUIRED',
            challengeType: 'captcha',
            reason: 'Verify human',
          }),
        },
        {},
      ),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);
  });

  it('handles unread polling alarm only when enabled, connected, idle, and not halted', async () => {
    const tabController = new AutomationTabController({
      getPacingConfig: async () => ({ pacingSeconds: 0, jitterRatio: 0 }),
    });
    vi.spyOn(tabController, 'navigateAndWaitForHydration').mockResolvedValue({
      tabId: 15,
      url: 'https://www.upwork.com/ab/messages/rooms',
      loggedIn: true,
    });

    const unreadUpdates: number[] = [];
    const deps = {
      tabController,
      proxyFetch: async () => new Response('{}'),
      getSelectors: async () => BUNDLED_SELECTORS,
      onUnreadUpdated: (n: number) => unreadUpdates.push(n),
      sendTabMessage: async () => ({
        ok: true,
        rooms: [{ upwork_room_id: 'r1', unread_count: 3 }],
      }),
    };

    // Disabled by default -> skipped
    const ranDisabled = await handleUnreadPollAlarm(
      deps,
      { wsConnected: true, killSwitchActive: false, humanActionRequired: false },
      { name: UNREAD_POLL_ALARM_NAME },
    );
    expect(ranDisabled).toBe(false);

    // Enable -> skips when killSwitchActive=true, runs when clear
    await unreadPollEnabledItem.setValue(true);
    const ranKilled = await handleUnreadPollAlarm(
      deps,
      { wsConnected: true, killSwitchActive: true, humanActionRequired: false },
      { name: UNREAD_POLL_ALARM_NAME },
    );
    expect(ranKilled).toBe(false);

    const ranOk = await handleUnreadPollAlarm(
      deps,
      { wsConnected: true, killSwitchActive: false, humanActionRequired: false },
      { name: UNREAD_POLL_ALARM_NAME },
    );
    expect(ranOk).toBe(true);
    expect(unreadUpdates).toEqual([3]);
  });

  it('executeProposalSubmit rejects when tab stays on /apply/ without confirmation or on form-validation-error, and confirms on delayed redirect or banner', async () => {
    const makeController = () => {
      const tabController = new AutomationTabController({
        getPacingConfig: async () => ({ pacingSeconds: 0, jitterRatio: 0 }),
      });
      vi.spyOn(tabController, 'navigateAndWaitForHydration').mockResolvedValue({
        tabId: 88,
        url: 'https://www.upwork.com/nx/proposals/job/~0221/apply/',
        loggedIn: true,
      });
      return tabController;
    };

    // (a) Stays on /apply/ without confirmation banner -> rejects PROPOSAL_SUBMIT_UNCONFIRMED
    await expect(
      executeProposalSubmit(
        {
          tabController: makeController(),
          proxyFetch: async () => new Response('{}'),
          getSelectors: async () => BUNDLED_SELECTORS,
          confirmPollMaxAttempts: 3,
          confirmPollIntervalMs: 1,
          getTab: async () => ({
            id: 88,
            url: 'https://www.upwork.com/nx/proposals/job/~0221/apply/',
          }),
          sendTabMessage: async (_tabId, msg) => {
            const m = msg as { type?: string };
            if (m.type === 'CONTENT_PROPOSAL_SUBMIT') {
              return { ok: true, clicked: true };
            }
            if (m.type === 'CONTENT_CHECK_PROPOSAL_CONFIRMATION') {
              return { ok: true, confirmed: false };
            }
            return { ok: true, loggedIn: true };
          },
        },
        { upwork_job_id: '~0221', cover_letter: 'Hello' },
      ),
    ).rejects.toMatchObject({ code: 'PROPOSAL_SUBMIT_UNCONFIRMED' });

    // (b) Visible form-validation-error -> rejects FORM_VALIDATION_ERROR
    await expect(
      executeProposalSubmit(
        {
          tabController: makeController(),
          proxyFetch: async () => new Response('{}'),
          getSelectors: async () => BUNDLED_SELECTORS,
          confirmPollMaxAttempts: 5,
          confirmPollIntervalMs: 1,
          getTab: async () => ({
            id: 88,
            url: 'https://www.upwork.com/nx/proposals/job/~0221/apply/',
          }),
          sendTabMessage: async (_tabId, msg) => {
            const m = msg as { type?: string };
            if (m.type === 'CONTENT_PROPOSAL_SUBMIT') {
              return { ok: true, clicked: true };
            }
            if (m.type === 'CONTENT_CHECK_PROPOSAL_CONFIRMATION') {
              return {
                ok: true,
                confirmed: false,
                validationError: 'Required screening question #1 unanswered',
              };
            }
            return { ok: true, loggedIn: true };
          },
        },
        { upwork_job_id: '~0221', cover_letter: 'Hello' },
      ),
    ).rejects.toMatchObject({ code: 'FORM_VALIDATION_ERROR' });

    // (c1) Delayed redirect to /nx/proposals/confirmation -> succeeds
    let tabCalls = 0;
    const delayedRedirectRes = await executeProposalSubmit(
      {
        tabController: makeController(),
        proxyFetch: async () => new Response('{}'),
        getSelectors: async () => BUNDLED_SELECTORS,
        confirmPollMaxAttempts: 6,
        confirmPollIntervalMs: 1,
        getTab: async () => {
          tabCalls += 1;
          return {
            id: 88,
            url:
              tabCalls >= 3
                ? 'https://www.upwork.com/nx/proposals/confirmation/555'
                : 'https://www.upwork.com/nx/proposals/job/~0221/apply/',
          };
        },
        sendTabMessage: async (_tabId, msg) => {
          const m = msg as { type?: string };
          if (m.type === 'CONTENT_PROPOSAL_SUBMIT') {
            return { ok: true, clicked: true };
          }
          return { ok: true, confirmed: false };
        },
      },
      { upwork_job_id: '~0221', cover_letter: 'Hello' },
    );
    expect(delayedRedirectRes.submitted).toBe(true);
    expect(delayedRedirectRes.upwork_proposal_url).toBe(
      'https://www.upwork.com/nx/proposals/confirmation/555',
    );

    // (c2) In-page confirmation banner without URL change -> succeeds
    let bannerCalls = 0;
    const bannerRes = await executeProposalSubmit(
      {
        tabController: makeController(),
        proxyFetch: async () => new Response('{}'),
        getSelectors: async () => BUNDLED_SELECTORS,
        confirmPollMaxAttempts: 5,
        confirmPollIntervalMs: 1,
        getTab: async () => ({
          id: 88,
          url: 'https://www.upwork.com/nx/proposals/job/~0221/apply/',
        }),
        sendTabMessage: async (_tabId, msg) => {
          const m = msg as { type?: string };
          if (m.type === 'CONTENT_PROPOSAL_SUBMIT') {
            return { ok: true, clicked: true };
          }
          if (m.type === 'CONTENT_CHECK_PROPOSAL_CONFIRMATION') {
            bannerCalls += 1;
            return { ok: true, confirmed: bannerCalls >= 2 };
          }
          return { ok: true };
        },
      },
      { upwork_job_id: '~0221', cover_letter: 'Hello' },
    );
    expect(bannerRes.submitted).toBe(true);
  });

  it('executeMessagesSend waits for delayed DOM confirmation and rejects when unconfirmed', async () => {
    const makeController = () => {
      const tabController = new AutomationTabController({
        getPacingConfig: async () => ({ pacingSeconds: 0, jitterRatio: 0 }),
      });
      vi.spyOn(tabController, 'navigateAndWaitForHydration').mockResolvedValue({
        tabId: 91,
        url: 'https://www.upwork.com/ab/messages/rooms/room_alpha',
        loggedIn: true,
      });
      return tabController;
    };

    // Delayed confirmation: polls 3 times while composer is still populated, confirms on 4th
    let pollCount = 0;
    const okRes = await executeMessagesSend(
      {
        tabController: makeController(),
        proxyFetch: async () => new Response('{}'),
        getSelectors: async () => BUNDLED_SELECTORS,
        confirmPollMaxAttempts: 6,
        confirmPollIntervalMs: 1,
        sendTabMessage: async (_tabId, msg) => {
          const m = msg as { type?: string };
          if (m.type === 'CONTENT_MESSAGES_SEND') {
            return { ok: true, clicked: true, body: 'Shipping today!' };
          }
          if (m.type === 'CONTENT_MESSAGES_GET') {
            pollCount += 1;
            if (pollCount < 4) {
              return { ok: true, composer_value: 'Shipping today!', messages: [] };
            }
            return {
              ok: true,
              composer_value: '',
              messages: [{ body: 'Shipping today!' }],
            };
          }
          return { ok: true };
        },
      },
      { room_id: 'room_alpha', body: 'Shipping today!' },
    );
    expect(okRes.sent).toBe(true);
    expect(pollCount).toBe(4);

    // Never confirmed within polling window -> rejects MESSAGE_SEND_UNCONFIRMED
    await expect(
      executeMessagesSend(
        {
          tabController: makeController(),
          proxyFetch: async () => new Response('{}'),
          getSelectors: async () => BUNDLED_SELECTORS,
          confirmPollMaxAttempts: 3,
          confirmPollIntervalMs: 1,
          sendTabMessage: async (_tabId, msg) => {
            const m = msg as { type?: string };
            if (m.type === 'CONTENT_MESSAGES_SEND') {
              return { ok: true, clicked: true, body: 'Still stuck' };
            }
            if (m.type === 'CONTENT_MESSAGES_GET') {
              return { ok: true, composer_value: 'Still stuck', messages: [] };
            }
            return { ok: true };
          },
        },
        { room_id: 'room_alpha', body: 'Still stuck' },
      ),
    ).rejects.toMatchObject({ code: 'MESSAGE_SEND_UNCONFIRMED' });
  });

  it('pollMessagesAndSync and handleUnreadPollAlarm sync polled rooms to Postgres after releasing tab lock', async () => {
    const tabController = new AutomationTabController({
      getPacingConfig: async () => ({ pacingSeconds: 0, jitterRatio: 0 }),
    });
    vi.spyOn(tabController, 'navigateAndWaitForHydration').mockResolvedValue({
      tabId: 19,
      url: 'https://www.upwork.com/ab/messages/rooms',
      loggedIn: true,
    });

    const syncCalls: Array<{ path: string; busyDuringFetch: boolean; body: unknown }> = [];
    const deps = {
      tabController,
      proxyFetch: async (path: string, init?: RequestInit) => {
        syncCalls.push({
          path,
          busyDuringFetch: tabController.getState().busy,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response('{}', { status: 200 });
      },
      getSelectors: async () => BUNDLED_SELECTORS,
      sendTabMessage: async () => ({
        ok: true,
        rooms: [
          {
            upwork_room_id: 'room_beta',
            client_name: 'Bob Mercer',
            upwork_job_id: '~022999',
            unread_count: 1,
            last_message_snippet: 'Can we kick off tomorrow?',
          },
        ],
      }),
    };

    await pollMessagesAndSync(deps, 'manual-poll-1');
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0].path).toBe('/api/messages/threads/sync');
    expect(syncCalls[0].busyDuringFetch).toBe(false);
    expect(syncCalls[0].body).toMatchObject({
      rooms: [expect.objectContaining({ upwork_room_id: 'room_beta', unread_count: 1 })],
    });
  });

  it('executeMessagesGet omits unread_count when absent in content reply and forwards when explicitly provided', async () => {
    const tabController = new AutomationTabController({
      getPacingConfig: async () => ({ pacingSeconds: 0, jitterRatio: 0 }),
    });
    vi.spyOn(tabController, 'navigateAndWaitForHydration').mockResolvedValue({
      tabId: 21,
      url: 'https://www.upwork.com/ab/messages/rooms/room_777',
      loggedIn: true,
    });

    const omittedReply = await executeMessagesGet(
      {
        tabController,
        proxyFetch: async () => new Response('{}'),
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage: async () => ({
          ok: true,
          room_id: 'room_777',
          upwork_room_id: 'room_777',
          client_name: 'Dana',
          messages: [],
        }),
      },
      { room_id: 'room_777' },
    );
    expect('unread_count' in omittedReply).toBe(false);

    const explicitReply = await executeMessagesGet(
      {
        tabController,
        proxyFetch: async () => new Response('{}'),
        getSelectors: async () => BUNDLED_SELECTORS,
        sendTabMessage: async () => ({
          ok: true,
          room_id: 'room_777',
          upwork_room_id: 'room_777',
          unread_count: 4,
          messages: [],
        }),
      },
      { room_id: 'room_777' },
    );
    expect(explicitReply.unread_count).toBe(4);
  });

  it('executeProposalSubmit detects post-submit login redirect as HumanActionRequiredError', async () => {
    const tabController = new AutomationTabController({
      getPacingConfig: async () => ({ pacingSeconds: 0, jitterRatio: 0 }),
    });
    vi.spyOn(tabController, 'navigateAndWaitForHydration').mockResolvedValue({
      tabId: 55,
      url: 'https://www.upwork.com/nx/proposals/job/~0221/apply/',
      loggedIn: true,
    });

    await expect(
      executeProposalSubmit(
        {
          tabController,
          proxyFetch: async () => new Response('{}'),
          getSelectors: async () => BUNDLED_SELECTORS,
          confirmPollMaxAttempts: 3,
          confirmPollIntervalMs: 1,
          getTab: async () => ({
            id: 55,
            url: 'https://www.upwork.com/ab/account-security/login',
          }),
          sendTabMessage: async () => ({ ok: true, clicked: true }),
        },
        { upwork_job_id: '~0221', cover_letter: 'Hello' },
      ),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);
  });

  it('executeMessagesSend does not false-confirm duplicate thread text while composer still holds body', async () => {
    const tabController = new AutomationTabController({
      getPacingConfig: async () => ({ pacingSeconds: 0, jitterRatio: 0 }),
    });
    vi.spyOn(tabController, 'navigateAndWaitForHydration').mockResolvedValue({
      tabId: 92,
      url: 'https://www.upwork.com/ab/messages/rooms/room_dup',
      loggedIn: true,
    });

    await expect(
      executeMessagesSend(
        {
          tabController,
          proxyFetch: async () => new Response('{}'),
          getSelectors: async () => BUNDLED_SELECTORS,
          confirmPollMaxAttempts: 2,
          confirmPollIntervalMs: 1,
          sendTabMessage: async (_tabId, msg) => {
            const m = msg as { type?: string };
            if (m.type === 'CONTENT_MESSAGES_SEND') {
              return { ok: true, clicked: true, body: 'Thanks!', prior_message_count: 1 };
            }
            if (m.type === 'CONTENT_MESSAGES_GET') {
              return {
                ok: true,
                composer_value: 'Thanks!',
                messages: [{ body: 'Thanks!' }],
              };
            }
            return { ok: true };
          },
        },
        { room_id: 'room_dup', body: 'Thanks!' },
      ),
    ).rejects.toMatchObject({ code: 'MESSAGE_SEND_UNCONFIRMED' });
  });

  it('executeMessagesSend throws HumanActionRequiredError on off-origin Cloudflare redirect during post-send poll', async () => {
    const tabController = new AutomationTabController({
      getPacingConfig: async () => ({ pacingSeconds: 0, jitterRatio: 0 }),
    });
    vi.spyOn(tabController, 'navigateAndWaitForHydration').mockResolvedValue({
      tabId: 99,
      url: 'https://www.upwork.com/ab/messages/rooms/room_alpha',
      loggedIn: true,
    });

    await expect(
      executeMessagesSend(
        {
          tabController,
          proxyFetch: async () => new Response('{}'),
          getSelectors: async () => BUNDLED_SELECTORS,
          confirmPollMaxAttempts: 3,
          confirmPollIntervalMs: 1,
          getTab: async () => ({
            id: 99,
            url: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1',
          }),
          sendTabMessage: async (_tabId, msg) => {
            const m = msg as { type?: string };
            if (m.type === 'CONTENT_MESSAGES_SEND') {
              return { ok: true, clicked: true, body: 'Shipping today!' };
            }
            if (m.type === 'CONTENT_MESSAGES_GET') {
              throw new Error('Receiving end does not exist');
            }
            return { ok: true };
          },
        },
        { room_id: 'room_alpha', body: 'Shipping today!' },
      ),
    ).rejects.toBeInstanceOf(HumanActionRequiredError);
  });
});
