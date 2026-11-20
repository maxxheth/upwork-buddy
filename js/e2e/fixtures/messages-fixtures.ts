import type { AuthState, MockMessageEntry, MockRoomState } from '../server/mock-types.ts';
import { escapeHtml, renderSharedAuthenticatedNav } from './challenge-fixtures.ts';

export function createInitialRoomsState(): Record<string, MockRoomState> {
  return {
    room_alpha: {
      roomId: 'room_alpha',
      aliases: ['room_e2e_101', 'room_101'],
      clientName: 'Alice Vance',
      clientCompany: 'Acme HVAC Co',
      jobId: '~022115332344639171',
      jobTitle: 'On-Page SEO Expert Needed — Audit + WordPress/Elementor Implementation',
      unreadCount: 2,
      messages: [
        {
          id: 'msg_101_1',
          sender: 'Alice Vance',
          body: 'Hi Maxx, thanks for your proposal! Here is our site brief.',
          timestamp: '2026-11-19T16:30:00Z',
          attachments: ['brief.pdf', 'requirements-v2.pdf'],
          interviewCard: 'Interview Invitation: On-Page SEO Expert Needed',
        },
        {
          id: 'msg_101_2',
          sender: 'Maxx Freelancer',
          body: 'Thanks Alice! Reviewing the brief now and will share my audit notes shortly.',
          timestamp: '2026-11-19T16:35:00Z',
        },
        {
          id: 'msg_101_3',
          sender: 'Alice Vance',
          body: 'Can you share your availability for a quick call tomorrow?',
          timestamp: '2026-11-19T16:42:00Z',
        },
      ],
    },
    room_beta: {
      roomId: 'room_beta',
      aliases: ['room_e2e_102'],
      clientName: 'Bob Mercer',
      clientCompany: 'Northstar Labs',
      jobId: '~022111887415567641941',
      jobTitle: 'Python FastAPI Microservices Architect',
      unreadCount: 0,
      messages: [
        {
          id: 'msg_102_1',
          sender: 'Bob Mercer',
          body: 'Thanks for the architecture notes!',
          timestamp: '2026-11-18T14:20:00Z',
        },
      ],
    },
    room_e2e_103: {
      roomId: 'room_e2e_103',
      aliases: [],
      clientName: 'Clara Chen',
      clientCompany: 'Velo Studio',
      jobId: '~022111887415567641942',
      jobTitle: 'Full Website Migration (GoDaddy to WordPress)',
      unreadCount: 1,
      messages: [
        {
          id: 'msg_103_1',
          sender: 'Clara Chen',
          body: "We'd like to invite you to an interview.",
          timestamp: '2026-11-17T11:00:00Z',
          interviewCard: 'Interview Invitation: Full Website Migration',
          offerCard: 'Contract Offer: $1,000.00 Fixed Price',
        },
      ],
    },
    room_777: {
      roomId: 'room_777',
      aliases: [],
      clientName: 'Dana Brooks',
      clientCompany: 'Linked Systems',
      jobId: '~01linked',
      jobTitle: 'Linked Message Thread Integration Job',
      unreadCount: 2,
      messages: [
        {
          id: 'msg_777_1',
          sender: 'Dana Brooks',
          body: 'Following up on our active proposal for the linked integration project.',
          timestamp: '2026-11-19T09:15:00Z',
        },
        {
          id: 'msg_777_2',
          sender: 'Dana Brooks',
          body: 'Could you confirm the milestone schedule?',
          timestamp: '2026-11-19T09:30:00Z',
        },
      ],
    },
    room_202: {
      roomId: 'room_202',
      aliases: [],
      clientName: 'Evan Wright',
      clientCompany: 'Policy Guardrails Inc',
      jobId: '~022115332344639171',
      jobTitle: 'On-Page SEO Expert Needed',
      unreadCount: 0,
      messages: [
        {
          id: 'msg_202_1',
          sender: 'Evan Wright',
          body: 'Ready whenever you want to send over the timeline.',
          timestamp: '2026-11-19T08:00:00Z',
        },
      ],
    },
    room_901: {
      roomId: 'room_901',
      aliases: [],
      clientName: 'Fiona Sterling',
      clientCompany: 'Sterling Cloud',
      jobId: '~09msg',
      jobTitle: 'Client Reply Triage Go Architecture Job',
      unreadCount: 0,
      messages: [
        {
          id: 'msg_901_1',
          sender: 'Fiona Sterling',
          body: 'Looking forward to reviewing your Go proposal.',
          timestamp: '2026-11-19T07:00:00Z',
        },
      ],
    },
  };
}

export function resolveRoomById(
  rooms: Record<string, MockRoomState>,
  requestedId: string,
): MockRoomState | undefined {
  if (rooms[requestedId]) {
    return rooms[requestedId];
  }
  for (const room of Object.values(rooms)) {
    if (room.aliases.includes(requestedId)) {
      return room;
    }
  }
  return undefined;
}

export function renderMessagesRoomsPage(
  authState: AuthState,
  rooms: Record<string, MockRoomState>,
): string {
  const roomOrder = ['room_alpha', 'room_beta', 'room_e2e_103', 'room_777', 'room_202', 'room_901'];
  const seen = new Set<string>();
  const orderedRooms: MockRoomState[] = [];
  for (const id of roomOrder) {
    const r = rooms[id];
    if (r) {
      orderedRooms.push(r);
      seen.add(id);
    }
  }
  for (const r of Object.values(rooms)) {
    if (!seen.has(r.roomId)) {
      orderedRooms.push(r);
    }
  }

  const itemsHtml = orderedRooms
    .map((room) => {
      const lastMsg = room.messages[room.messages.length - 1];
      const badgeHidden = room.unreadCount <= 0 ? ' hidden' : '';
      return `    <a class="room-item air3-card" data-test="room-item" data-room-id="${escapeHtml(room.roomId)}" data-job-id="${escapeHtml(room.jobId)}" href="/ab/messages/rooms/${escapeHtml(room.roomId)}">
      <div data-test="room-client-name">${escapeHtml(room.clientName)}</div>
      <div data-test="room-client-company">${escapeHtml(room.clientCompany)}</div>
      <div data-test="room-job-title">${escapeHtml(room.jobTitle)}</div>
      <div data-test="room-last-message">${escapeHtml(lastMsg?.body ?? '')}</div>
      <time data-test="room-timestamp">${escapeHtml(lastMsg?.timestamp ?? '')}</time>
      <span data-test="unread-count" class="air3-badge"${badgeHidden}>${room.unreadCount}</span>
    </a>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Messages - Upwork</title></head>
<body>
${renderSharedAuthenticatedNav(authState)}
<main data-test="messages-rooms-page">
  <h1>Messages</h1>
  <div data-test="rooms-list" class="rooms-list">
${itemsHtml}
  </div>
</main>
</body>
</html>`;
}

function renderMessageItem(msg: MockMessageEntry): string {
  const attachmentsHtml = (msg.attachments ?? [])
    .map(
      (att) =>
        `      <a data-test="message-attachment" href="/att/${encodeURIComponent(att)}">${escapeHtml(att)}</a>`,
    )
    .join('\n');
  const interviewHtml = msg.interviewCard
    ? `      <div data-test="interview-card" class="air3-card">${escapeHtml(msg.interviewCard)}</div>`
    : '';
  const offerHtml = msg.offerCard
    ? `      <div data-test="offer-card" class="air3-card">${escapeHtml(msg.offerCard)}</div>`
    : '';

  return `    <article data-test="message-item" data-message-id="${escapeHtml(msg.id)}">
      <span data-test="message-sender">${escapeHtml(msg.sender)}</span>
      <time data-test="message-timestamp" datetime="${escapeHtml(msg.timestamp)}">${escapeHtml(msg.timestamp)}</time>
      <div data-test="message-body">${escapeHtml(msg.body)}</div>
${attachmentsHtml}
${interviewHtml}
${offerHtml}
    </article>`;
}

export function renderMessageThreadPage(
  authState: AuthState,
  rooms: Record<string, MockRoomState>,
  requestedRoomId: string,
): { status: number; html: string } {
  const room = resolveRoomById(rooms, requestedRoomId);
  if (!room || requestedRoomId === 'room_missing') {
    return {
      status: 404,
      html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Conversation Not Found - Upwork</title></head>
<body>
${renderSharedAuthenticatedNav(authState)}
<main data-test="room-not-found">
  <h1>Conversation not found</h1>
  <p>The requested conversation could not be found.</p>
</main>
</body>
</html>`,
    };
  }

  const messagesHtml = room.messages.map(renderMessageItem).join('\n');

  return {
    status: 200,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>${escapeHtml(room.clientName)} - Messages | Upwork</title></head>
<body>
${renderSharedAuthenticatedNav(authState)}
<main data-test="message-thread-page" data-room-id="${escapeHtml(requestedRoomId)}" data-canonical-room-id="${escapeHtml(room.roomId)}">
  <header data-test="room-header">
    <h1 data-test="room-client-name">${escapeHtml(room.clientName)}</h1>
    <span data-test="room-client-company">${escapeHtml(room.clientCompany)}</span>
    <a data-test="room-job-link" href="/jobs/Job_${escapeHtml(room.jobId)}/">${escapeHtml(room.jobTitle)}</a>
  </header>

  <section data-test="message-list" class="message-list">
${messagesHtml}
  </section>

  <footer data-test="message-composer">
    <textarea data-test="composer-textarea" aria-label="Write a message" placeholder="Write a message..."></textarea>
    <button type="button" data-test="composer-send-btn" class="air3-btn air3-btn-primary">Send</button>
  </footer>
</main>
<script>
(() => {
  const roomId = ${JSON.stringify(room.roomId)};
  const state = window.__mockComposerState = {
    roomId,
    draftText: '',
  };

  const textarea = document.querySelector('[data-test="composer-textarea"]');
  const sendBtn = document.querySelector('[data-test="composer-send-btn"]');
  const messageList = document.querySelector('[data-test="message-list"]');

  if (textarea) {
    ['input', 'change'].forEach((evt) => {
      textarea.addEventListener(evt, (e) => {
        state.draftText = e.target.value;
      });
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', async () => {
      if (!state.draftText.trim()) {
        return;
      }
      const textToSend = state.draftText;
      const res = await fetch('/api/mock/messages/' + encodeURIComponent(roomId) + '/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: textToSend }),
      });
      const data = await res.json();
      if (data.redirectUrl) {
        window.location.href = data.redirectUrl;
        return;
      }
      if (data.ok && data.message && messageList) {
        const article = document.createElement('article');
        article.className = 'message-item';
        article.setAttribute('data-test', 'message-item');
        article.setAttribute('data-message-id', data.message.id);

        const senderEl = document.createElement('span');
        senderEl.setAttribute('data-test', 'message-sender');
        senderEl.textContent = data.message.sender;

        const timeEl = document.createElement('time');
        timeEl.setAttribute('data-test', 'message-timestamp');
        timeEl.setAttribute('datetime', data.message.timestamp);
        timeEl.textContent = data.message.timestamp;

        const bodyEl = document.createElement('div');
        bodyEl.setAttribute('data-test', 'message-body');
        bodyEl.textContent = data.message.body;

        article.appendChild(senderEl);
        article.appendChild(timeEl);
        article.appendChild(bodyEl);
        messageList.appendChild(article);

        state.draftText = '';
        if (textarea) textarea.value = '';
      }
    });
  }
})();
</script>
</body>
</html>`,
  };
}
