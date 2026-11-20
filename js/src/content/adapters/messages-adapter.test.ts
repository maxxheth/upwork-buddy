import { describe, expect, it, vi } from 'vitest';
import {
  extractMessageRooms,
  extractMessageThread,
  fillMessageComposer,
  sendMessageFromComposer,
} from './messages-adapter';

describe('MessagesAdapter', () => {
  it('extracts message rooms and handles hidden vs visible unread counts', () => {
    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <nav data-test="nav-user-menu">User</nav>
        <a class="room-item" data-test="room-item" data-room-id="room_alpha" data-job-id="~022115332344639171" href="/ab/messages/rooms/room_alpha">
          <span data-test="room-client-name">Alice Client</span>
          <span data-test="room-client-company">Acme Corp</span>
          <span data-test="room-job-title">Go MCP Server</span>
          <span data-test="room-last-message">Can you start Monday?</span>
          <time data-test="room-timestamp" datetime="2026-11-20T01:00:00Z">1h ago</time>
          <span data-test="unread-count">2</span>
        </a>
        <a class="room-item" data-test="room-item" data-room-id="room_beta" href="/ab/messages/rooms/room_beta">
          <span data-test="room-client-name">Bob Builder</span>
          <span data-test="room-job-title">React Dashboard</span>
          <span data-test="room-last-message">Thanks!</span>
          <time data-test="room-timestamp">Yesterday</time>
          <span data-test="unread-count" hidden>5</span>
        </a>
      </body></html>`,
      'text/html',
    );

    const res = extractMessageRooms(doc, undefined, {
      href: 'https://www.upwork.com/ab/messages/rooms',
      pathname: '/ab/messages/rooms',
    });
    expect(res.ok).toBe(true);
    expect(res.rooms).toHaveLength(2);
    expect(res.rooms[0]).toMatchObject({
      upwork_room_id: 'room_alpha',
      client_name: 'Alice Client',
      client_company: 'Acme Corp',
      upwork_job_id: '~022115332344639171',
      unread_count: 2,
    });
    expect(res.rooms[1].unread_count).toBe(0);
  });

  it('extracts thread history with attachments, interview_card, offer_card, and detects ROOM_NOT_FOUND', () => {
    const notFoundDoc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <nav data-test="nav-user-menu">User</nav>
        <div data-test="room-not-found">Conversation not found</div>
      </body></html>`,
      'text/html',
    );
    const nfRes = extractMessageThread(notFoundDoc, 'room_missing', undefined, {
      href: 'https://www.upwork.com/ab/messages/rooms/room_missing',
      pathname: '/ab/messages/rooms/room_missing',
    });
    expect(nfRes.ok).toBe(false);
    expect(nfRes.errorCode).toBe('ROOM_NOT_FOUND');

    const threadDoc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <nav data-test="nav-user-menu">User</nav>
        <main data-test="message-thread-page" data-room-id="room_alpha" data-canonical-room-id="room_alpha">
          <header data-test="room-header">
            <span data-test="room-client-name">Alice Client</span>
            <span data-test="room-client-company">Acme</span>
            <a data-test="room-job-link" href="/jobs/~022115332344639171">Go MCP Server</a>
          </header>
          <article data-test="message-item" data-message-id="m1" data-sender-role="client">
            <span data-test="message-sender">Alice Client</span>
            <time data-test="message-timestamp" datetime="2026-11-20T00:50:00Z">00:50</time>
            <div data-test="message-body">Please review attached spec.</div>
            <a data-test="message-attachment" href="/att/1/spec.pdf">spec.pdf</a>
          </article>
          <article data-test="message-item" data-message-id="m2" data-sender-role="client">
            <span data-test="message-sender">Alice Client</span>
            <time data-test="message-timestamp" datetime="2026-11-20T01:00:00Z">01:00</time>
            <div data-test="message-body">Invitation sent</div>
            <div data-test="interview-card" data-card-id="int-1">Technical Interview</div>
            <div data-test="offer-card" data-card-id="off-1">Fixed Offer $1400</div>
          </article>
          <textarea data-test="composer-textarea"></textarea>
          <button type="button" data-test="composer-send-btn">Send</button>
        </main>
      </body></html>`,
      'text/html',
    );

    const res = extractMessageThread(threadDoc, 'room_alpha', undefined, {
      href: 'https://www.upwork.com/ab/messages/rooms/room_alpha',
      pathname: '/ab/messages/rooms/room_alpha',
    });
    expect(res.ok).toBe(true);
    expect(res.upwork_job_id).toBe('~022115332344639171');
    expect(res.unread_count).toBeUndefined();
    expect(res.messages).toHaveLength(2);
    expect(res.messages[0].attachments).toEqual([
      { filename: 'spec.pdf', url: 'https://www.upwork.com/att/1/spec.pdf' },
    ]);
    expect(res.messages[1].interview_card).toMatchObject({ id: 'int-1' });
    expect(res.messages[1].offer_card).toMatchObject({ id: 'off-1' });
  });

  it('fills composer without clicking send, rejects whitespace, and sends when approved', () => {
    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <nav data-test="nav-user-menu">User</nav>
        <main data-test="message-thread-page" data-room-id="room_alpha">
          <textarea data-test="composer-textarea"></textarea>
          <button type="button" data-test="composer-send-btn">Send</button>
        </main>
      </body></html>`,
      'text/html',
    );
    const loc = {
      href: 'https://www.upwork.com/ab/messages/rooms/room_alpha',
      pathname: '/ab/messages/rooms/room_alpha',
    };
    const sendBtn = doc.querySelector<HTMLButtonElement>("button[data-test='composer-send-btn']");
    const sendSpy = vi.fn();
    sendBtn?.addEventListener('click', sendSpy);

    const blankRes = fillMessageComposer(doc, '   ', undefined, loc);
    expect(blankRes.ok).toBe(false);
    expect(blankRes.errorCode).toBe('INVALID_PARAMS');

    const draftRes = fillMessageComposer(doc, 'Yes, Monday at 10am works!', undefined, loc);
    expect(draftRes.ok).toBe(true);
    expect(draftRes.prefilled).toBe(true);
    expect(sendSpy).not.toHaveBeenCalled();

    const sendRes = sendMessageFromComposer(doc, 'Yes, Monday at 10am works!', undefined, loc);
    expect(sendRes.ok).toBe(true);
    expect(sendRes.clicked).toBe(true);
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // Explicit blank body must reject with INVALID_PARAMS and NOT click Send even when composer holds prior text
    const composerEl = doc.querySelector<HTMLTextAreaElement>(
      "textarea[data-test='composer-textarea']",
    );
    if (composerEl) composerEl.value = 'Stale composer draft text';
    const blankSendRes = sendMessageFromComposer(doc, '   ', undefined, loc);
    expect(blankSendRes.ok).toBe(false);
    expect(blankSendRes.errorCode).toBe('INVALID_PARAMS');
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('halts with HUMAN_ACTION_REQUIRED on challenge DOM', () => {
    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <div id="cf-challenge-running">Checking your browser</div>
      </body></html>`,
      'text/html',
    );
    const res = extractMessageRooms(doc, undefined, {
      href: 'https://www.upwork.com/ab/messages/rooms',
      pathname: '/ab/messages/rooms',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('HUMAN_ACTION_REQUIRED');
  });

  it('survives malformed room href encoding, parses prefixed unread counts, strips javascript: URLs, and verifies contenteditable fill', () => {
    const roomsDoc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <nav class="air3-nav-freelancer"></nav>
        <div data-test="room-item">
          <a href="/ab/messages/rooms/room%E0%A4%A">Bad Enc</a>
          <span data-test="unread-count">New (3)</span>
        </div>
        <div data-test="room-item" data-room-id="room_xss">
          <a href="javascript:alert(1)">Evil Link</a>
          <span data-test="unread-count">2</span>
        </div>
      </body></html>`,
      'text/html',
    );
    const roomsRes = extractMessageRooms(roomsDoc, undefined, {
      href: 'https://www.upwork.com/ab/messages/rooms',
      pathname: '/ab/messages/rooms',
    });
    expect(roomsRes.ok).toBe(true);
    expect(roomsRes.rooms).toHaveLength(2);
    expect(roomsRes.rooms[0]?.room_id).toBe('room%E0%A4%A');
    expect(roomsRes.rooms[0]?.unread_count).toBe(3);
    expect(roomsRes.rooms[1]?.room_url).toBe('');

    const threadDoc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <nav class="air3-nav-freelancer"></nav>
        <div data-test="message-thread-page" data-room-id="room_att">
          <div data-test="message-item">
            <strong data-test="message-sender">Client</strong>
            <div data-test="message-body">See attachment</div>
            <a data-test="message-attachment" href="javascript:alert(2)">payload.pdf</a>
          </div>
          <div contenteditable="true" role="textbox"></div>
        </div>
      </body></html>`,
      'text/html',
    );
    const threadRes = extractMessageThread(threadDoc, 'room_att', undefined, {
      href: 'https://www.upwork.com/ab/messages/rooms/room_att',
      pathname: '/ab/messages/rooms/room_att',
    });
    expect(threadRes.ok).toBe(true);
    expect(threadRes.messages[0]?.attachments[0]?.url).toBe('');

    // Simulate contenteditable failing to retain text
    const editable = threadDoc.querySelector("div[contenteditable='true']");
    if (!editable) throw new Error('Expected contenteditable');
    Object.defineProperty(editable, 'textContent', {
      configurable: true,
      get: () => '',
      set: () => {},
    });
    const fillRes = fillMessageComposer(threadDoc, 'Draft text', undefined, {
      href: 'https://www.upwork.com/ab/messages/rooms/room_att',
      pathname: '/ab/messages/rooms/room_att',
    });
    expect(fillRes.ok).toBe(false);
    expect(fillRes.errorCode).toBe('FILL_VERIFICATION_FAILED');
  });
});
