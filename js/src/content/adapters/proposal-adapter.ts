import type { BridgeErrorCode, ChallengeType } from '../../shared/protocol';
import type {
  ProposalFillParams,
  ProposalSubmitParams,
  ProposalVerificationSnapshot,
} from '../../shared/schemas';
import { BUNDLED_SELECTORS, type SelectorConfig } from '../../shared/selectors';
import {
  checkAuthAndChallengeGuards,
  extractDirectText,
  extractFullText,
  extractUpworkJobID,
  isJobNotFoundDocument,
  normalizeJobUrl,
  queryAllSafe,
} from '../selector-engine';

export interface ProposalFormResult {
  ok: boolean;
  clicked?: boolean;
  snapshot?: ProposalVerificationSnapshot;
  errorCode?: BridgeErrorCode;
  challengeType?: ChallengeType;
  reason?: string;
  url?: string;
}

export interface SyncedProposalRow {
  upwork_proposal_id: string;
  upwork_proposal_url: string;
  upwork_job_id: string;
  job_url: string;
  job_title: string;
  status: string;
  submitted_at: string;
  bid_amount: number | null;
  connects: number | null;
  viewed_by_client: boolean;
}

export interface ProposalsListResult {
  ok: boolean;
  proposals: SyncedProposalRow[];
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

function isElementVisible(el: Element | null): boolean {
  if (!el) return false;
  if (el.hasAttribute('hidden')) return false;
  const style = (el as HTMLElement).style;
  if (style && style.display === 'none') return false;
  return true;
}

export function setNativeInputValue(
  el: HTMLInputElement | HTMLTextAreaElement,
  value: string,
): void {
  const proto =
    el.tagName.toLowerCase() === 'textarea'
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

function resolveSelectTargetValue(el: HTMLSelectElement, value: string): string {
  const options = Array.from(el.options);
  const exact = options.find((opt) => opt.value === value);
  if (exact) {
    return exact.value;
  }
  const lower = value.trim().toLowerCase();
  const byText = options.find(
    (opt) =>
      opt.value.trim().toLowerCase() === lower ||
      (opt.textContent ?? '').trim().toLowerCase().includes(lower),
  );
  return byText ? byText.value : value;
}

export function setNativeSelectValue(el: HTMLSelectElement, value: string): void {
  const targetValue = resolveSelectTargetValue(el, value);

  const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (descriptor?.set) {
    descriptor.set.call(el, targetValue);
  } else {
    el.value = targetValue;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.dispatchEvent(new Event('blur', { bubbles: true }));
}

export function setRadioValue(doc: Document, name: string, value: string): boolean {
  const radios = Array.from(doc.querySelectorAll<HTMLInputElement>(`input[type="radio"]`));
  const match = radios.find((r) => r.name === name && r.value === value);
  if (!match) {
    return false;
  }
  match.checked = true;
  match.dispatchEvent(new Event('input', { bubbles: true }));
  match.dispatchEvent(new Event('change', { bubbles: true }));
  match.click();
  return true;
}

function parseFirstNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '');
  const m = /-?\d+(?:\.\d+)?/.exec(cleaned);
  if (!m) return null;
  const num = Number(m[0]);
  return Number.isFinite(num) ? num : null;
}

function parseFirstInt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '');
  const m = /-?\d+/.exec(cleaned);
  if (!m) return null;
  const num = Number.parseInt(m[0], 10);
  return Number.isSafeInteger(num) ? num : null;
}

function checkProposalPagePreconditions(
  doc: Document,
  selectors: SelectorConfig,
  loc: Pick<Location, 'href' | 'pathname'>,
): ProposalFormResult | null {
  const probe = checkAuthAndChallengeGuards(doc, loc, selectors);
  if (probe.challengeDetected) {
    return {
      ok: false,
      errorCode: 'HUMAN_ACTION_REQUIRED',
      challengeType: probe.challengeType ?? 'unknown',
      reason: probe.challengeReason ?? 'Verification challenge detected',
      url: probe.url,
    };
  }
  if (!probe.loggedIn) {
    return {
      ok: false,
      errorCode: 'HUMAN_ACTION_REQUIRED',
      challengeType: 'login',
      reason: 'Upwork session is not logged in',
      url: probe.url,
    };
  }

  const alreadyAppliedEl = doc.querySelector("[data-test='already-applied-banner']");
  if (isElementVisible(alreadyAppliedEl)) {
    return {
      ok: false,
      errorCode: 'ALREADY_APPLIED',
      reason: 'ALREADY_APPLIED: You have already submitted a proposal for this job',
      url: loc.href,
    };
  }

  if (isJobNotFoundDocument(doc, selectors)) {
    return {
      ok: false,
      errorCode: 'JOB_UNAVAILABLE',
      reason: 'JOB_UNAVAILABLE: Job posting is unavailable or closed',
      url: loc.href,
    };
  }

  return null;
}

function detectBidType(doc: Document, selectors: SelectorConfig): 'hourly' | 'fixed' {
  const viewFields = selectors.views.proposal_apply?.fields;
  const hourlyEl = findFirstElement<HTMLInputElement>(
    doc,
    viewFields?.hourly_rate_input?.selectors ?? [
      "input[data-test='hourly-rate-input']",
      "input[data-test='hourly-rate']",
    ],
  );
  if (hourlyEl && isElementVisible(hourlyEl)) {
    return 'hourly';
  }
  const badge = doc.querySelector("[data-test='contract-type-badge']");
  if (badge && (badge.textContent ?? '').toLowerCase().includes('hourly')) {
    return 'hourly';
  }
  return 'fixed';
}

function isQuestionContainerRequired(
  container: Element,
  inputEl: HTMLInputElement | HTMLTextAreaElement | null,
  promptText: string,
): boolean {
  if (inputEl?.required || inputEl?.getAttribute('aria-required') === 'true') {
    return true;
  }
  if (container.getAttribute('data-required') === 'true') {
    return true;
  }
  const lowerPrompt = promptText.toLowerCase();
  return lowerPrompt.includes('*') || lowerPrompt.includes('(required)');
}

export function buildVerificationSnapshot(
  doc: Document,
  selectors: SelectorConfig = BUNDLED_SELECTORS,
): ProposalVerificationSnapshot {
  const fields = selectors.views.proposal_apply?.fields;

  const coverEl = findFirstElement<HTMLTextAreaElement>(
    doc,
    fields?.cover_letter?.selectors ?? [
      "textarea[data-test='cover-letter-textarea']",
      "textarea[aria-labelledby*='cover_letter']",
    ],
  );
  const coverText = coverEl ? coverEl.value : '';

  const bidType = detectBidType(doc, selectors);
  const bidEl = findFirstElement<HTMLInputElement>(
    doc,
    bidType === 'hourly'
      ? (fields?.hourly_rate_input?.selectors ?? ["input[data-test='hourly-rate-input']"])
      : (fields?.fixed_bid_input?.selectors ?? ["input[data-test='fixed-price-input']"]),
  );
  const bidAmount = bidEl ? parseFirstNumber(bidEl.value) : null;

  const feeEl = doc.querySelector("[data-test='upwork-fee']");
  const netEl = doc.querySelector("[data-test='estimated-earnings']");
  const estimatedFee = feeEl ? parseFirstNumber(extractFullText(feeEl)) : null;
  const estimatedNet = netEl ? parseFirstNumber(extractFullText(netEl)) : null;

  const connectsEl = findFirstElement(
    doc,
    fields?.connects_cost?.selectors ?? [
      "[data-test='required-connects-value']",
      "[data-test='connects-required-cost'] strong",
      "[data-test='connects-cost']",
    ],
  );
  const connectsCost = connectsEl ? parseFirstInt(extractFullText(connectsEl)) : null;

  const boostEl = findFirstElement<HTMLInputElement>(
    doc,
    fields?.boost_bid_input?.selectors ?? [
      "input[data-test='boost-connects-input']",
      "input[data-test='boost-connects']",
    ],
  );
  const boostConnects = boostEl ? (parseFirstInt(boostEl.value) ?? 0) : null;

  const totalEl = doc.querySelector("[data-test='total-connects-value']");
  const parsedTotal = totalEl ? parseFirstInt(extractFullText(totalEl)) : null;
  const totalConnects = parsedTotal ?? (connectsCost ?? 0) + (boostConnects ?? 0);

  const availEl = doc.querySelector(
    "[data-test='available-connects'] strong, [data-test='available-connects']",
  );
  const availableConnects = availEl ? parseFirstInt(extractFullText(availEl)) : null;
  const insufficientConnects =
    availableConnects !== null && totalConnects > availableConnects ? true : false;

  const rateIncEl = findFirstElement<HTMLElement>(
    doc,
    fields?.rate_increase_dropdown?.selectors ?? [
      "select[data-test='rate-increase-select']",
      "[data-test='rate-increase-select']",
    ],
  );
  const rateIncrease = rateIncEl
    ? rateIncEl.tagName.toLowerCase() === 'select'
      ? String((rateIncEl as HTMLSelectElement).value ?? '').trim()
      : extractFullText(rateIncEl).trim()
    : '';

  const containers = findAllElements(
    doc,
    fields?.screening_question_containers?.selectors ?? [
      "[data-test='screening-question-item']",
      "[data-test='screening-question']",
    ],
  );
  const labelSelectors = fields?.screening_question_label?.selectors ?? [
    "[data-test='question-prompt']",
    'label',
    '.label',
    'p',
  ];
  const inputSelectors = fields?.screening_question_input?.selectors ?? [
    "[data-test='screening-answer-input']",
    'textarea',
    "input[type='text']",
  ];

  let unansweredRequired = 0;
  const screeningAnswers: ProposalVerificationSnapshot['screening_answers'] = [];

  for (let i = 0; i < containers.length; i++) {
    const container = containers[i];
    const labelEl = findFirstElement(container, labelSelectors);
    const inputEl = findFirstElement<HTMLInputElement | HTMLTextAreaElement>(
      container,
      inputSelectors,
    );
    const prompt = labelEl ? extractFullText(labelEl) : `Question ${i + 1}`;
    const answer = inputEl ? inputEl.value : '';
    const required = isQuestionContainerRequired(container, inputEl, prompt);
    if (required && answer.trim().length === 0) {
      unansweredRequired += 1;
    }
    screeningAnswers.push({
      index: i,
      prompt,
      answer,
      required,
    });
  }

  const attachInput = doc.querySelector<HTMLInputElement>(
    "input[data-test='proposal-attachment-input'], input[type='file']",
  );
  const filenames: string[] = [];
  if (attachInput?.files) {
    for (let i = 0; i < attachInput.files.length; i++) {
      const f = attachInput.files.item(i);
      if (f?.name) filenames.push(f.name);
    }
  }

  return {
    ok: true,
    cover_letter_length: coverText.trim().length,
    bid_type: bidType,
    bid_amount: bidAmount,
    estimated_fee: estimatedFee,
    estimated_net: estimatedNet,
    connects_cost: connectsCost,
    boost_connects: boostConnects,
    total_connects: totalConnects,
    available_connects: availableConnects,
    insufficient_connects: insufficientConnects,
    ...(rateIncrease ? { rate_increase: rateIncrease } : {}),
    attachment_state: {
      present: Boolean(attachInput),
      files_count: filenames.length,
      filenames,
    },
    unanswered_required_questions: unansweredRequired,
    screening_answers: screeningAnswers,
  };
}

export function fillProposalForm(
  doc: Document,
  params: ProposalFillParams,
  selectors: SelectorConfig = BUNDLED_SELECTORS,
  loc: Pick<Location, 'href' | 'pathname'> = typeof window !== 'undefined'
    ? window.location
    : { href: '', pathname: '' },
): ProposalFormResult {
  const precheck = checkProposalPagePreconditions(doc, selectors, loc);
  if (precheck) {
    return precheck;
  }

  const fields = selectors.views.proposal_apply?.fields;
  const coverEl = findFirstElement<HTMLTextAreaElement>(
    doc,
    fields?.cover_letter?.selectors ?? [
      "textarea[data-test='cover-letter-textarea']",
      "textarea[aria-labelledby*='cover_letter']",
    ],
  );
  if (!coverEl) {
    return {
      ok: false,
      errorCode: 'SELECTOR_BROKEN',
      reason: 'Cover letter textarea not found on proposal apply page',
      url: loc.href,
    };
  }

  setNativeInputValue(coverEl, params.cover_letter);

  const detectedBidType = detectBidType(doc, selectors);
  const effectiveBidType = params.bid_type || detectedBidType;

  let targetBidEl: HTMLInputElement | null = null;
  if (params.bid_amount !== undefined && params.bid_amount !== null) {
    targetBidEl = findFirstElement<HTMLInputElement>(
      doc,
      effectiveBidType === 'hourly'
        ? (fields?.hourly_rate_input?.selectors ?? ["input[data-test='hourly-rate-input']"])
        : (fields?.fixed_bid_input?.selectors ?? ["input[data-test='fixed-price-input']"]),
    );
    if (!targetBidEl) {
      return {
        ok: false,
        errorCode: 'SELECTOR_BROKEN',
        reason: `SELECTOR_BROKEN: ${effectiveBidType === 'hourly' ? 'Hourly rate' : 'Fixed bid'} input not found on proposal apply page`,
        url: loc.href,
      };
    }
    setNativeInputValue(targetBidEl, String(params.bid_amount));
  }

  let rateSelectEl: HTMLSelectElement | null = null;
  let expectedRateIncrease: string | null = null;
  if (params.rate_increase) {
    const rateEl = findFirstElement(
      doc,
      fields?.rate_increase_dropdown?.selectors ?? [
        "select[data-test='rate-increase-select']",
        "[data-test='rate-increase-select']",
      ],
    );
    if (!rateEl) {
      return {
        ok: false,
        errorCode: 'SELECTOR_BROKEN',
        reason: 'SELECTOR_BROKEN: Rate increase selector not found on proposal apply page',
        url: loc.href,
      };
    }
    if (rateEl.tagName.toLowerCase() === 'select') {
      rateSelectEl = rateEl as HTMLSelectElement;
      expectedRateIncrease = resolveSelectTargetValue(rateSelectEl, params.rate_increase);
      setNativeSelectValue(rateSelectEl, params.rate_increase);
    } else if (rateEl instanceof HTMLElement) {
      rateEl.click();
    }
  }

  let verifiedMilestonesRequested = false;
  if (effectiveBidType === 'fixed' && params.milestones && params.milestones.length > 0) {
    setRadioValue(doc, 'milestoneMode', 'milestone');
    const addBtn = doc.querySelector<HTMLButtonElement>("button[data-test='add-milestone-btn']");
    let rows = Array.from(doc.querySelectorAll("[data-test='milestone-row']"));
    while (addBtn && rows.length < params.milestones.length) {
      const prevLen = rows.length;
      addBtn.click();
      rows = Array.from(doc.querySelectorAll("[data-test='milestone-row']"));
      if (rows.length <= prevLen) break;
    }
    if (rows.length === 0) {
      return {
        ok: false,
        errorCode: 'SELECTOR_BROKEN',
        reason: 'SELECTOR_BROKEN: Milestone row controls not found on proposal apply page',
        url: loc.href,
      };
    }
    verifiedMilestonesRequested = true;
    for (let i = 0; i < params.milestones.length && i < rows.length; i++) {
      const ms = params.milestones[i];
      const row = rows[i];
      const descEl = row.querySelector<HTMLInputElement>(
        "input[data-test='milestone-description'], input[name*='description']",
      );
      if (descEl) setNativeInputValue(descEl, ms.description);

      const dueEl = row.querySelector<HTMLInputElement>(
        "input[data-test='milestone-due-date'], input[name*='dueDate']",
      );
      if (dueEl && ms.due_date) setNativeInputValue(dueEl, ms.due_date);

      const amtEl = row.querySelector<HTMLInputElement>(
        "input[data-test='milestone-amount'], input[name*='amount']",
      );
      if (amtEl) setNativeInputValue(amtEl, String(ms.amount));
    }
  }

  let boostEl: HTMLInputElement | null = null;
  if (params.boost_connects !== undefined && params.boost_connects !== null) {
    boostEl = findFirstElement<HTMLInputElement>(
      doc,
      fields?.boost_bid_input?.selectors ?? [
        "input[data-test='boost-connects-input']",
        "input[data-test='boost-connects']",
      ],
    );
    if (!boostEl) {
      return {
        ok: false,
        errorCode: 'SELECTOR_BROKEN',
        reason: 'SELECTOR_BROKEN: Boost connects input not found on proposal apply page',
        url: loc.href,
      };
    }
    setNativeInputValue(boostEl, String(params.boost_connects));
  }

  const expectedScreeningChecks: Array<{
    index: number;
    inputEl: HTMLInputElement | HTMLTextAreaElement;
    expected: string;
  }> = [];
  if (params.screening_answers && params.screening_answers.length > 0) {
    const containers = findAllElements(
      doc,
      fields?.screening_question_containers?.selectors ?? [
        "[data-test='screening-question-item']",
        "[data-test='screening-question']",
      ],
    );
    const labelSelectors = fields?.screening_question_label?.selectors ?? [
      "[data-test='question-prompt']",
      'label',
      '.label',
      'p',
    ];
    const inputSelectors = fields?.screening_question_input?.selectors ?? [
      "[data-test='screening-answer-input']",
      'textarea',
      "input[type='text']",
    ];

    for (let i = 0; i < containers.length; i++) {
      const container = containers[i];
      const labelEl = findFirstElement(container, labelSelectors);
      const inputEl = findFirstElement<HTMLInputElement | HTMLTextAreaElement>(
        container,
        inputSelectors,
      );
      if (!inputEl) continue;

      const promptText = labelEl ? extractFullText(labelEl).toLowerCase() : '';
      let matchedAnswer: string | undefined;

      for (const candidate of params.screening_answers) {
        if (typeof candidate !== 'string' && candidate.index === i) {
          matchedAnswer = candidate.answer;
          break;
        }
      }
      if (matchedAnswer === undefined && promptText) {
        for (const candidate of params.screening_answers) {
          if (
            typeof candidate !== 'string' &&
            candidate.prompt &&
            promptText.includes(candidate.prompt.trim().toLowerCase())
          ) {
            matchedAnswer = candidate.answer;
            break;
          }
        }
      }
      if (matchedAnswer === undefined && i < params.screening_answers.length) {
        const positional = params.screening_answers[i];
        if (typeof positional === 'string') {
          matchedAnswer = positional;
        } else if (positional.index === undefined && !positional.prompt) {
          matchedAnswer = positional.answer;
        }
      }

      if (matchedAnswer !== undefined) {
        setNativeInputValue(inputEl, matchedAnswer);
        if (matchedAnswer.trim().length > 0) {
          expectedScreeningChecks.push({
            index: i,
            inputEl,
            expected: matchedAnswer.trim(),
          });
        }
      }
    }
  }

  const snapshot = buildVerificationSnapshot(doc, selectors);

  // Read-back verification checks
  if (coverEl.value.trim() !== params.cover_letter.trim()) {
    return {
      ok: false,
      errorCode: 'FILL_VERIFICATION_FAILED',
      reason: 'FILL_VERIFICATION_FAILED: Cover letter value was not retained by DOM',
      snapshot,
      url: loc.href,
    };
  }

  if (params.bid_amount !== undefined && params.bid_amount !== null && targetBidEl) {
    const readBid = parseFirstNumber(targetBidEl.value);
    if (readBid === null || Math.abs(readBid - params.bid_amount) >= 0.01) {
      return {
        ok: false,
        errorCode: 'FILL_VERIFICATION_FAILED',
        reason: `FILL_VERIFICATION_FAILED: Bid amount read-back mismatch (expected ${params.bid_amount}, got ${targetBidEl.value})`,
        snapshot,
        url: loc.href,
      };
    }
  }

  if (
    rateSelectEl &&
    expectedRateIncrease !== null &&
    rateSelectEl.value !== expectedRateIncrease
  ) {
    return {
      ok: false,
      errorCode: 'FILL_VERIFICATION_FAILED',
      reason: `FILL_VERIFICATION_FAILED: Rate increase read-back mismatch (expected ${expectedRateIncrease}, got ${rateSelectEl.value})`,
      snapshot,
      url: loc.href,
    };
  }

  if (verifiedMilestonesRequested && params.milestones && params.milestones.length > 0) {
    const currentRows = Array.from(doc.querySelectorAll("[data-test='milestone-row']"));
    if (currentRows.length < params.milestones.length) {
      return {
        ok: false,
        errorCode: 'FILL_VERIFICATION_FAILED',
        reason: `FILL_VERIFICATION_FAILED: Milestone count mismatch (expected ${params.milestones.length}, got ${currentRows.length})`,
        snapshot,
        url: loc.href,
      };
    }
    for (let i = 0; i < params.milestones.length; i++) {
      const ms = params.milestones[i];
      const row = currentRows[i];
      const descEl = row.querySelector<HTMLInputElement>(
        "input[data-test='milestone-description'], input[name*='description']",
      );
      if (descEl && ms.description.trim() !== '' && descEl.value.trim() !== ms.description.trim()) {
        return {
          ok: false,
          errorCode: 'FILL_VERIFICATION_FAILED',
          reason: `FILL_VERIFICATION_FAILED: Milestone #${i + 1} description was not retained by DOM`,
          snapshot,
          url: loc.href,
        };
      }
      const amtEl = row.querySelector<HTMLInputElement>(
        "input[data-test='milestone-amount'], input[name*='amount']",
      );
      if (amtEl) {
        const readAmt = parseFirstNumber(amtEl.value);
        if (readAmt === null || Math.abs(readAmt - ms.amount) >= 0.01) {
          return {
            ok: false,
            errorCode: 'FILL_VERIFICATION_FAILED',
            reason: `FILL_VERIFICATION_FAILED: Milestone #${i + 1} amount read-back mismatch (expected ${ms.amount}, got ${amtEl.value})`,
            snapshot,
            url: loc.href,
          };
        }
      }
    }
  }

  if (params.boost_connects !== undefined && params.boost_connects !== null && boostEl) {
    const readBoost = parseFirstInt(boostEl.value) ?? 0;
    if (readBoost !== params.boost_connects) {
      return {
        ok: false,
        errorCode: 'FILL_VERIFICATION_FAILED',
        reason: `FILL_VERIFICATION_FAILED: Boost connects mismatch (expected ${params.boost_connects}, got ${readBoost})`,
        snapshot,
        url: loc.href,
      };
    }
  }

  for (const check of expectedScreeningChecks) {
    const domVal = check.inputEl.value.trim();
    const snapVal = snapshot.screening_answers[check.index]?.answer.trim() ?? domVal;
    if (domVal !== check.expected || snapVal !== check.expected) {
      return {
        ok: false,
        errorCode: 'FILL_VERIFICATION_FAILED',
        reason: `FILL_VERIFICATION_FAILED: Screening answer #${check.index + 1} was not retained by DOM`,
        snapshot,
        url: loc.href,
      };
    }
  }

  if (
    snapshot.available_connects !== null &&
    snapshot.available_connects !== undefined &&
    (snapshot.total_connects ?? 0) > snapshot.available_connects
  ) {
    return {
      ok: false,
      errorCode: 'INSUFFICIENT_CONNECTS',
      reason: `INSUFFICIENT_CONNECTS: Proposal requires ${snapshot.total_connects} connects but only ${snapshot.available_connects} available`,
      snapshot,
      url: loc.href,
    };
  }

  return {
    ok: true,
    snapshot,
    url: loc.href,
  };
}

export function submitProposalForm(
  doc: Document,
  params: ProposalSubmitParams,
  selectors: SelectorConfig = BUNDLED_SELECTORS,
  loc: Pick<Location, 'href' | 'pathname'> = typeof window !== 'undefined'
    ? window.location
    : { href: '', pathname: '' },
): ProposalFormResult {
  const precheck = checkProposalPagePreconditions(doc, selectors, loc);
  if (precheck) {
    return precheck;
  }

  const fields = selectors.views.proposal_apply?.fields;
  const coverEl = findFirstElement<HTMLTextAreaElement>(
    doc,
    fields?.cover_letter?.selectors ?? ["textarea[data-test='cover-letter-textarea']"],
  );
  if (coverEl && coverEl.value.trim().length === 0 && params.cover_letter) {
    const fillResult = fillProposalForm(
      doc,
      {
        upwork_job_id: params.upwork_job_id,
        apply_url: params.apply_url,
        cover_letter: params.cover_letter,
        bid_type: params.bid_type ?? '',
        bid_amount: params.bid_amount,
        milestones: params.milestones,
        rate_increase: params.rate_increase,
        duration: params.duration,
        boost_connects: params.boost_connects,
        screening_answers: params.screening_answers,
      },
      selectors,
      loc,
    );
    if (!fillResult.ok) {
      return fillResult;
    }
  }

  const snapshot = buildVerificationSnapshot(doc, selectors);
  if (snapshot.unanswered_required_questions > 0) {
    return {
      ok: false,
      errorCode: 'SCREENING_QUESTIONS_REQUIRED',
      reason: `SCREENING_QUESTIONS_REQUIRED: ${snapshot.unanswered_required_questions} required screening question(s) remain unanswered`,
      snapshot,
      url: loc.href,
    };
  }

  if (snapshot.cover_letter_length === 0) {
    return {
      ok: false,
      errorCode: 'INVALID_PARAMS',
      reason: 'Cover letter is required before submitting proposal',
      snapshot,
      url: loc.href,
    };
  }

  if (
    snapshot.available_connects !== null &&
    snapshot.available_connects !== undefined &&
    (snapshot.total_connects ?? 0) > snapshot.available_connects
  ) {
    return {
      ok: false,
      errorCode: 'INSUFFICIENT_CONNECTS',
      reason: `INSUFFICIENT_CONNECTS: Proposal requires ${snapshot.total_connects} connects but only ${snapshot.available_connects} available`,
      snapshot,
      url: loc.href,
    };
  }

  const submitBtn = findFirstElement<HTMLButtonElement>(
    doc,
    fields?.submit_button?.selectors ?? [
      "button[data-test='submit-proposal-btn']",
      "button[data-test='submit-proposal']",
      "button[data-cy='submit-proposal-btn']",
      'footer button.air3-btn-primary',
    ],
  );
  if (!submitBtn || submitBtn.disabled) {
    return {
      ok: false,
      errorCode: 'SELECTOR_BROKEN',
      reason: 'Submit proposal button not found or disabled',
      snapshot,
      url: loc.href,
    };
  }

  submitBtn.click();
  return {
    ok: true,
    clicked: true,
    snapshot,
    url: loc.href,
  };
}

function normalizeProposalRowStatus(raw: string): string {
  const lower = raw.trim().toLowerCase();
  if (lower.includes('offer')) return 'offer';
  if (lower.includes('interview')) return 'interviewing';
  if (lower.includes('view')) return 'viewed';
  if (lower.includes('archiv')) return 'archived';
  if (lower.includes('withdraw') || lower.includes('declin') || lower.includes('reject')) {
    return 'rejected';
  }
  return 'submitted';
}

export function extractProposalsList(
  doc: Document,
  selectors: SelectorConfig = BUNDLED_SELECTORS,
  loc: Pick<Location, 'href' | 'pathname'> = typeof window !== 'undefined'
    ? window.location
    : { href: '', pathname: '' },
): ProposalsListResult {
  const probe = checkAuthAndChallengeGuards(doc, loc, selectors);
  if (probe.challengeDetected || !probe.loggedIn) {
    return {
      ok: false,
      proposals: [],
      errorCode: 'HUMAN_ACTION_REQUIRED',
      challengeType: probe.challengeType ?? 'login',
      reason: probe.challengeReason ?? 'Upwork authentication required',
      url: probe.url,
    };
  }

  const viewCfg = selectors.views.proposals_list;
  const rows = findAllElements(
    doc,
    viewCfg?.container_selectors ?? [
      "[data-test='proposal-row']",
      "section.air3-card-section[data-test*='proposal']",
      '.proposals-list li',
    ],
  );

  const fields = viewCfg?.fields;
  const proposals: SyncedProposalRow[] = [];

  for (const row of rows) {
    const titleEl = findFirstElement(
      row,
      fields?.job_title?.selectors ?? [
        "a[data-test='proposal-job-link']",
        "a[href*='/jobs/']",
        "[data-test='proposal-job-title']",
      ],
    );
    const jobTitle = titleEl ? extractFullText(titleEl) : '';
    const jobHref =
      row
        .querySelector<HTMLAnchorElement>("a[data-test='proposal-job-link'], a[href*='/jobs/']")
        ?.getAttribute('href') ?? '';
    const jobUrl = jobHref ? normalizeJobUrl(jobHref) : '';

    const propLinkEl = findFirstElement<HTMLAnchorElement>(
      row,
      fields?.proposal_url?.selectors ?? ["a[href*='/nx/proposals/']", "a[href*='/proposals/']"],
    );
    const propHref = propLinkEl?.getAttribute('href') ?? '';
    const attrProposalId = row.getAttribute('data-proposal-id') ?? '';
    const proposalId =
      attrProposalId || extractUpworkJobID(propHref) || `prop-${proposals.length + 1}`;
    const proposalUrl = propHref
      ? propHref.startsWith('/')
        ? `https://www.upwork.com${propHref}`
        : propHref
      : proposalId.startsWith('~')
        ? `https://www.upwork.com/nx/proposals/${proposalId}`
        : '';

    const upworkJobId = extractUpworkJobID(jobUrl) ?? extractUpworkJobID(jobHref) ?? '';

    const statusEl = findFirstElement(
      row,
      fields?.status?.selectors ?? ["[data-test='proposal-status']", '.air3-badge'],
    );
    const rawStatus =
      row.getAttribute('data-status') ?? (statusEl ? extractFullText(statusEl) : '');
    const status = normalizeProposalRowStatus(rawStatus);

    const dateEl = findFirstElement(
      row,
      fields?.submitted_at?.selectors ?? [
        "[data-test='proposal-submitted-date']",
        "[data-test='submitted-date']",
        'time',
      ],
    );
    const submittedAt = dateEl ? (dateEl.getAttribute('datetime') ?? extractFullText(dateEl)) : '';

    const bidEl = findFirstElement(
      row,
      fields?.bid_amount?.selectors ?? ["[data-test='proposal-bid']", "[data-test='bid-amount']"],
    );
    const bidAmount = bidEl ? parseFirstNumber(extractFullText(bidEl)) : null;

    const connectsEl = row.querySelector("[data-test='proposal-connects']");
    const connects = connectsEl ? parseFirstInt(extractFullText(connectsEl)) : null;

    const viewedEl = findFirstElement(
      row,
      fields?.viewed_badge?.selectors ?? ["[data-test='client-viewed']", '.viewed-by-client'],
    );
    const viewedByClient = Boolean(viewedEl && isElementVisible(viewedEl)) || status === 'viewed';

    if (!jobTitle && !upworkJobId && !proposalUrl) {
      continue;
    }

    proposals.push({
      upwork_proposal_id: proposalId,
      upwork_proposal_url: proposalUrl,
      upwork_job_id: upworkJobId,
      job_url: jobUrl,
      job_title: jobTitle,
      status,
      submitted_at: submittedAt,
      bid_amount: bidAmount,
      connects,
      viewed_by_client: viewedByClient,
    });
  }

  return {
    ok: true,
    proposals,
    url: loc.href,
  };
}

export function extractApplyPageState(
  doc: Document,
  selectors: SelectorConfig = BUNDLED_SELECTORS,
  loc: Pick<Location, 'href' | 'pathname'> = typeof window !== 'undefined'
    ? window.location
    : { href: '', pathname: '' },
): ProposalFormResult {
  const precheck = checkProposalPagePreconditions(doc, selectors, loc);
  if (precheck) {
    return precheck;
  }
  return {
    ok: true,
    snapshot: buildVerificationSnapshot(doc, selectors),
    url: loc.href,
  };
}

export { extractDirectText };
