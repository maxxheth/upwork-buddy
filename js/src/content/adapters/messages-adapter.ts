import type { BridgeErrorCode, ChallengeType } from '../../shared/protocol';
import { BUNDLED_SELECTORS, type SelectorConfig } from '../../shared/selectors';
import { sanitizeHttpUrl } from '../../utils';
import {
  checkAuthAndChallengeGuards,
  extractFullText,
  extractRenderedText,
  extractUpworkJobID,
  queryAllSafe,
} from '../selector-engine';
import { setNativeInputValue } from './proposal-adapter';

export interface ScrapedMessageRoom {
  upwork_room_id: string;
  room_id: string;
  room_url: string;
  client_name: string;
  client_company: string;
  job_title: string;
  upwork_job_id: string;
  last_message_snippet: string;
  last_message_at: string;
  unread_count: number;
}

export interface MessagesRoomsResult {
  ok: boolean;
  rooms: ScrapedMessageRoom[];
  errorCode?: BridgeErrorCode;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

export interface ScrapedMessageAttachment {
  filename: string;
  url: string;
}

export interface ScrapedMessageEntry {
  upwork_message_id: string;
  sender: string;
  sender_role: 'client' | 'freelancer' | 'system';
  body: string;
  sent_at: string;
  attachments: ScrapedMessageAttachment[];
  interview_card?: Record<string, unknown> | null;
  offer_card?: Record<string, unknown> | null;
}

export interface MessageThreadResult {
  ok: boolean;
  room_id: string;
  upwork_room_id: string;
  client_name: string;
  client_company: string;
  job_title: string;
  upwork_job_id: string;
  unread_count?: number;
  messages: ScrapedMessageEntry[];
  composer_value?: string;
  errorCode?: BridgeErrorCode;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

export interface MessageComposerResult {
  ok: boolean;
  prefilled?: boolean;
  clicked?: boolean;
  body?: string;
  prior_message_count?: number;
  errorCode?: BridgeErrorCode;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

function findFirstElement<T extends Element = Element>(
  root: Document | Element,
  selectors: string[],
): T | null {
  for (const sel of selectors) {
    const matched = queryAllSafe(root, sel);
    if (matched.length > 0) {
      return matched[0] as T;
    }
  }
  return null;
}

function findAllElements(root: Document | Element, selectors: string[]): Element[] {
  for (const sel of selectors) {
    const matched = queryAllSafe(root, sel);
    if (matched.length > 0) {
      return matched;
    }
  }
  return [];
}

function isBadgeVisible(el: Element | null): boolean {
  if (!el) return false;
  if (el.hasAttribute('hidden')) return false;
  const style = (el as HTMLElement).style;
  if (style && style.display === 'none') return false;
  return true;
}

function extractRoomIdFromHref(href: string): string {
  const m = /\/ab\/messages\/rooms\/([^/?#]+)/i.exec(href);
  if (!m) return '';
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function isRoomNotFound(doc: Document): boolean {
  if (doc.querySelector("[data-test='room-not-found']")) {
    return true;
  }
  const heading = doc.querySelector('h1, h2');
  if (heading) {
    const text = extractFullText(heading).toLowerCase();
    if (text.includes('conversation not found') || text.includes('room not found')) {
      return true;
    }
  }
  return false;
}

export function extractMessageRooms(
  doc: Document,
  selectors: SelectorConfig = BUNDLED_SELECTORS,
  loc: Pick<Location, 'href' | 'pathname'> = typeof window !== 'undefined'
    ? window.location
    : { href: '', pathname: '' },
): MessagesRoomsResult {
  const probe = checkAuthAndChallengeGuards(doc, loc, selectors);
  if (probe.challengeDetected || !probe.loggedIn) {
    return {
      ok: false,
      rooms: [],
      errorCode: 'HUMAN_ACTION_REQUIRED',
      challengeType: probe.challengeType ?? 'login',
      reason: probe.challengeReason ?? 'Upwork authentication required',
      url: probe.url,
    };
  }

  const viewCfg = selectors.views.messages_rooms;
  const fields = viewCfg?.fields;
  const containers = findAllElements(
    doc,
    viewCfg?.container_selectors ?? [
      "[data-test='room-item']",
      "[data-test='story-room-item']",
      'li.room-list-item',
    ],
  );

  const rooms: ScrapedMessageRoom[] = [];
  for (const card of containers) {
    let href = '';
    if (card.tagName.toLowerCase() === 'a') {
      href = card.getAttribute('href') ?? '';
    } else {
      const linkEl = findFirstElement<HTMLAnchorElement>(
        card,
        fields?.room_link?.selectors ?? ["a[href*='/ab/messages/rooms']", 'a'],
      );
      href = linkEl?.getAttribute('href') ?? '';
    }

    const roomId = card.getAttribute('data-room-id') || extractRoomIdFromHref(href);
    if (!roomId) {
      continue;
    }

    const clientEl = findFirstElement(
      card,
      fields?.client_name?.selectors ?? [
        "[data-test='room-client-name']",
        "[data-test='room-name']",
        '.room-title',
        'strong',
      ],
    );
    const companyEl = card.querySelector("[data-test='room-client-company']");
    const jobEl = findFirstElement(
      card,
      fields?.job_title?.selectors ?? [
        "[data-test='room-job-title']",
        "[data-test='room-subtitle']",
        '.room-topic',
      ],
    );
    const snippetEl = findFirstElement(
      card,
      fields?.last_message?.selectors ?? [
        "[data-test='room-last-message']",
        "[data-test='last-message']",
        '.room-preview',
      ],
    );
    const tsEl = findFirstElement(
      card,
      fields?.timestamp?.selectors ?? ["[data-test='room-timestamp']", 'time'],
    );
    const unreadEl = findFirstElement(
      card,
      fields?.unread_badge?.selectors ?? ["[data-test='unread-count']", '.air3-badge-notification'],
    );

    let unreadCount = 0;
    if (unreadEl && isBadgeVisible(unreadEl)) {
      const match = /\d+/.exec(extractFullText(unreadEl));
      const parsed = match ? Number.parseInt(match[0], 10) : Number.NaN;
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        unreadCount = parsed;
      }
    }

    const dataJobId = card.getAttribute('data-job-id') ?? '';
    const upworkJobId = extractUpworkJobID(dataJobId) ?? '';
    const rawRoomUrl = href
      ? href.startsWith('/')
        ? `https://www.upwork.com${href}`
        : href
      : `https://www.upwork.com/ab/messages/rooms/${encodeURIComponent(roomId)}`;
    const roomUrl = sanitizeHttpUrl(rawRoomUrl) ?? '';

    rooms.push({
      upwork_room_id: roomId,
      room_id: roomId,
      room_url: roomUrl,
      client_name: clientEl ? extractFullText(clientEl) : '',
      client_company: companyEl ? extractFullText(companyEl) : '',
      job_title: jobEl ? extractFullText(jobEl) : '',
      upwork_job_id: upworkJobId,
      last_message_snippet: snippetEl ? extractFullText(snippetEl) : '',
      last_message_at: tsEl ? (tsEl.getAttribute('datetime') ?? extractFullText(tsEl)) : '',
      unread_count: unreadCount,
    });
  }

  return {
    ok: true,
    rooms,
    url: loc.href,
  };
}

export function extractMessageThread(
  doc: Document,
  roomId: string,
  selectors: SelectorConfig = BUNDLED_SELECTORS,
  loc: Pick<Location, 'href' | 'pathname'> = typeof window !== 'undefined'
    ? window.location
    : { href: '', pathname: '' },
): MessageThreadResult {
  const probe = checkAuthAndChallengeGuards(doc, loc, selectors);
  if (probe.challengeDetected || !probe.loggedIn) {
    return {
      ok: false,
      room_id: roomId,
      upwork_room_id: roomId,
      client_name: '',
      client_company: '',
      job_title: '',
      upwork_job_id: '',
      messages: [],
      errorCode: 'HUMAN_ACTION_REQUIRED',
      challengeType: probe.challengeType ?? 'login',
      reason: probe.challengeReason ?? 'Upwork authentication required',
      url: probe.url,
    };
  }

  if (isRoomNotFound(doc)) {
    return {
      ok: false,
      room_id: roomId,
      upwork_room_id: roomId,
      client_name: '',
      client_company: '',
      job_title: '',
      upwork_job_id: '',
      messages: [],
      errorCode: 'ROOM_NOT_FOUND',
      reason: `ROOM_NOT_FOUND: Conversation ${roomId} not found`,
      url: loc.href,
    };
  }

  const pageEl = doc.querySelector("[data-test='message-thread-page']");
  const canonicalRoomId =
    pageEl?.getAttribute('data-canonical-room-id') ||
    pageEl?.getAttribute('data-room-id') ||
    extractRoomIdFromHref(loc.pathname) ||
    roomId;

  const headerEl = doc.querySelector("[data-test='room-header']") ?? doc;
  const clientNameEl = headerEl.querySelector("[data-test='room-client-name']");
  const clientCompanyEl = headerEl.querySelector("[data-test='room-client-company']");
  const jobLinkEl = headerEl.querySelector<HTMLAnchorElement>(
    "a[data-test='room-job-link'], a[href*='/jobs/']",
  );
  const jobTitle = jobLinkEl ? extractFullText(jobLinkEl) : '';
  const upworkJobId =
    extractUpworkJobID(jobLinkEl?.getAttribute('href') ?? '') ??
    extractUpworkJobID(pageEl?.getAttribute('data-job-id') ?? '') ??
    '';

  const viewCfg = selectors.views.messages_thread;
  const fields = viewCfg?.fields;
  const items = findAllElements(
    doc,
    viewCfg?.container_selectors ?? [
      "[data-test='message-item']",
      '.story-item',
      "[data-test='chat-story']",
    ],
  );

  const messages: ScrapedMessageEntry[] = [];
  for (const item of items) {
    const senderEl = findFirstElement(
      item,
      fields?.sender?.selectors ?? ["[data-test='message-sender']", '.story-author', 'strong'],
    );
    const tsEl = findFirstElement(
      item,
      fields?.timestamp?.selectors ?? ["[data-test='message-timestamp']", 'time'],
    );
    const bodyEl = findFirstElement(
      item,
      fields?.body?.selectors ?? ['.message-body', "[data-test='message-body']", '.story-message'],
    );

    const sender = senderEl ? extractFullText(senderEl) : '';
    const sentAt = tsEl ? (tsEl.getAttribute('datetime') ?? extractFullText(tsEl)) : '';
    const body = bodyEl ? extractRenderedText(bodyEl) : '';
    const roleAttr = (item.getAttribute('data-sender-role') ?? '').trim().toLowerCase();
    const senderRole: 'client' | 'freelancer' | 'system' =
      roleAttr === 'freelancer' || roleAttr === 'me'
        ? 'freelancer'
        : roleAttr === 'system'
          ? 'system'
          : 'client';

    const attachEls = findAllElements(
      item,
      fields?.attachments?.selectors ?? [
        "[data-test='message-attachment']",
        "a[href*='/att/']",
        "[data-test='message-attachment'] a",
      ],
    );
    const attachments: ScrapedMessageAttachment[] = [];
    for (const a of attachEls) {
      const link =
        a.tagName.toLowerCase() === 'a'
          ? (a as HTMLAnchorElement)
          : a.querySelector<HTMLAnchorElement>('a');
      const href = link?.getAttribute('href') ?? '';
      const filename = extractFullText(link ?? a);
      const rawAttachUrl = href.startsWith('/') ? `https://www.upwork.com${href}` : href;
      const safeAttachUrl = rawAttachUrl ? (sanitizeHttpUrl(rawAttachUrl) ?? '') : '';
      if (href || filename) {
        attachments.push({
          filename: filename || href,
          url: safeAttachUrl,
        });
      }
    }

    const interviewEl = item.querySelector("[data-test='interview-card']");
    const offerEl = item.querySelector("[data-test='offer-card']");
    const interviewCard = interviewEl
      ? {
          text: extractFullText(interviewEl),
          ...(interviewEl.getAttribute('data-card-id')
            ? { id: interviewEl.getAttribute('data-card-id') }
            : {}),
        }
      : null;
    const offerCard = offerEl
      ? {
          text: extractFullText(offerEl),
          ...(offerEl.getAttribute('data-card-id')
            ? { id: offerEl.getAttribute('data-card-id') }
            : {}),
        }
      : null;

    if (!body && attachments.length === 0 && !interviewCard && !offerCard) {
      continue;
    }

    messages.push({
      upwork_message_id: item.getAttribute('data-message-id') ?? '',
      sender,
      sender_role: senderRole,
      body,
      sent_at: sentAt,
      attachments,
      ...(interviewCard ? { interview_card: interviewCard } : {}),
      ...(offerCard ? { offer_card: offerCard } : {}),
    });
  }

  const composerEl = findFirstElement(
    doc,
    fields?.composer_input?.selectors ?? [
      "textarea[data-test='composer-textarea']",
      "[data-test='message-composer'] textarea",
      "div[contenteditable='true'][role='textbox']",
      "textarea[aria-label*='Write a message']",
    ],
  );
  const composerValue = composerEl
    ? 'value' in composerEl
      ? String((composerEl as HTMLTextAreaElement).value)
      : (composerEl.textContent ?? '')
    : undefined;

  return {
    ok: true,
    room_id: canonicalRoomId,
    upwork_room_id: canonicalRoomId,
    client_name: clientNameEl ? extractFullText(clientNameEl) : '',
    client_company: clientCompanyEl ? extractFullText(clientCompanyEl) : '',
    job_title: jobTitle,
    upwork_job_id: upworkJobId,
    messages,
    ...(composerValue !== undefined ? { composer_value: composerValue } : {}),
    url: loc.href,
  };
}

export function fillMessageComposer(
  doc: Document,
  body: string,
  selectors: SelectorConfig = BUNDLED_SELECTORS,
  loc: Pick<Location, 'href' | 'pathname'> = typeof window !== 'undefined'
    ? window.location
    : { href: '', pathname: '' },
): MessageComposerResult {
  const probe = checkAuthAndChallengeGuards(doc, loc, selectors);
  if (probe.challengeDetected || !probe.loggedIn) {
    return {
      ok: false,
      errorCode: 'HUMAN_ACTION_REQUIRED',
      challengeType: probe.challengeType ?? 'login',
      reason: probe.challengeReason ?? 'Upwork authentication required',
      url: probe.url,
    };
  }
  if (isRoomNotFound(doc)) {
    return {
      ok: false,
      errorCode: 'ROOM_NOT_FOUND',
      reason: 'ROOM_NOT_FOUND: Conversation not found',
      url: loc.href,
    };
  }
  if (!body || body.trim().length === 0) {
    return {
      ok: false,
      errorCode: 'INVALID_PARAMS',
      reason: 'Message body must not be empty',
      url: loc.href,
    };
  }

  const fields = selectors.views.messages_thread?.fields;
  const composerEl = findFirstElement(
    doc,
    fields?.composer_input?.selectors ?? [
      "textarea[data-test='composer-textarea']",
      "[data-test='message-composer'] textarea",
      "div[contenteditable='true'][role='textbox']",
      "textarea[aria-label*='Write a message']",
    ],
  );
  if (!composerEl) {
    return {
      ok: false,
      errorCode: 'SELECTOR_BROKEN',
      reason: 'Message composer input not found',
      url: loc.href,
    };
  }

  const tag = composerEl.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'input') {
    const input = composerEl as HTMLTextAreaElement | HTMLInputElement;
    setNativeInputValue(input, body);
    if (input.value.trim() !== body.trim()) {
      return {
        ok: false,
        errorCode: 'FILL_VERIFICATION_FAILED',
        reason: 'FILL_VERIFICATION_FAILED: Composer did not retain message draft',
        url: loc.href,
      };
    }
  } else {
    composerEl.textContent = body;
    composerEl.dispatchEvent(new Event('input', { bubbles: true }));
    composerEl.dispatchEvent(new Event('change', { bubbles: true }));
    composerEl.dispatchEvent(new Event('blur', { bubbles: true }));
    if ((composerEl.textContent ?? '').trim() !== body.trim()) {
      return {
        ok: false,
        errorCode: 'FILL_VERIFICATION_FAILED',
        reason: 'FILL_VERIFICATION_FAILED: Composer did not retain message draft',
        url: loc.href,
      };
    }
  }

  return {
    ok: true,
    prefilled: true,
    body,
    url: loc.href,
  };
}

export function sendMessageFromComposer(
  doc: Document,
  body?: string,
  selectors: SelectorConfig = BUNDLED_SELECTORS,
  loc: Pick<Location, 'href' | 'pathname'> = typeof window !== 'undefined'
    ? window.location
    : { href: '', pathname: '' },
): MessageComposerResult {
  const probe = checkAuthAndChallengeGuards(doc, loc, selectors);
  if (probe.challengeDetected || !probe.loggedIn) {
    return {
      ok: false,
      errorCode: 'HUMAN_ACTION_REQUIRED',
      challengeType: probe.challengeType ?? 'login',
      reason: probe.challengeReason ?? 'Upwork authentication required',
      url: probe.url,
    };
  }
  if (isRoomNotFound(doc)) {
    return {
      ok: false,
      errorCode: 'ROOM_NOT_FOUND',
      reason: 'ROOM_NOT_FOUND: Conversation not found',
      url: loc.href,
    };
  }

  const fields = selectors.views.messages_thread?.fields;
  if (body !== undefined) {
    const fillRes = fillMessageComposer(doc, body, selectors, loc);
    if (!fillRes.ok) {
      return fillRes;
    }
  }

  const composerEl = findFirstElement(
    doc,
    fields?.composer_input?.selectors ?? [
      "textarea[data-test='composer-textarea']",
      "[data-test='message-composer'] textarea",
      "div[contenteditable='true'][role='textbox']",
    ],
  );
  const currentText =
    composerEl &&
    ('value' in composerEl
      ? String((composerEl as HTMLTextAreaElement).value)
      : (composerEl.textContent ?? ''));
  if (!currentText || currentText.trim().length === 0) {
    return {
      ok: false,
      errorCode: 'INVALID_PARAMS',
      reason: 'Message composer is empty',
      url: loc.href,
    };
  }

  const sendBtn = findFirstElement<HTMLButtonElement>(
    doc,
    fields?.send_button?.selectors ?? [
      "button[data-test='composer-send-btn']",
      "button[data-test='send-message']",
      "button[aria-label*='Send']",
    ],
  );
  if (!sendBtn || sendBtn.disabled) {
    return {
      ok: false,
      errorCode: 'SELECTOR_BROKEN',
      reason: 'Message send button not found or disabled',
      url: loc.href,
    };
  }

  const priorMessageCount = extractMessageThread(doc, '', selectors, loc).messages.length;
  sendBtn.click();
  return {
    ok: true,
    clicked: true,
    body: currentText.trim(),
    prior_message_count: priorMessageCount,
    url: loc.href,
  };
}
