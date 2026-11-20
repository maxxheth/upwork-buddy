import { describe, expect, it, vi } from 'vitest';
import { extractProposalsList, fillProposalForm, submitProposalForm } from './proposal-adapter';

function buildProposalApplyDoc(opts?: {
  hourly?: boolean;
  alreadyApplied?: boolean;
  availableConnects?: number;
  requiredConnects?: number;
  lockBid?: boolean;
  requiredQuestion?: boolean;
}): Document {
  const isHourly = opts?.hourly ?? false;
  const avail = opts?.availableConnects ?? 50;
  const reqConn = opts?.requiredConnects ?? 12;
  const html = `<!doctype html>
  <html>
    <body>
      <nav data-test="nav-user-menu">User</nav>
      ${opts?.alreadyApplied ? '<div data-test="already-applied-banner">Already applied</div>' : ''}
      <span data-test="contract-type-badge">${isHourly ? 'Hourly' : 'Fixed-price'}</span>
      <textarea data-test="cover-letter-textarea"></textarea>
      ${
        isHourly
          ? `<input data-test="hourly-rate-input" value="75" />
             <select data-test="rate-increase-select">
               <option value="">None</option>
               <option value="3m">Every 3 months</option>
             </select>`
          : `<input data-test="fixed-price-input" value="1000" />
             <input type="radio" name="milestoneMode" value="project" checked />
             <input type="radio" name="milestoneMode" value="milestone" />
             <div data-test="milestones-container">
               <div data-test="milestone-row">
                 <input data-test="milestone-description" />
                 <input data-test="milestone-due-date" />
                 <input data-test="milestone-amount" />
               </div>
             </div>
             <button type="button" data-test="add-milestone-btn">Add milestone</button>`
      }
      <div data-test="screening-question-item" ${opts?.requiredQuestion ? 'data-required="true"' : ''}>
        <label data-test="question-prompt">How many years of Go experience?${opts?.requiredQuestion ? ' *' : ''}</label>
        <textarea data-test="screening-answer-input" ${opts?.requiredQuestion ? 'required' : ''}></textarea>
      </div>
      <div data-test="upwork-fee">$140</div>
      <div data-test="estimated-earnings">$1260</div>
      <div data-test="connects-required-cost"><strong data-test="required-connects-value">${reqConn}</strong></div>
      <div data-test="available-connects"><strong>${avail}</strong></div>
      <input data-test="boost-connects-input" value="0" />
      <input type="file" data-test="proposal-attachment-input" />
      <button type="button" data-test="submit-proposal-btn">Submit Proposal</button>
    </body>
  </html>`;

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const addBtn = doc.querySelector<HTMLButtonElement>("button[data-test='add-milestone-btn']");
  const msContainer = doc.querySelector("[data-test='milestones-container']");
  if (addBtn && msContainer) {
    addBtn.addEventListener('click', () => {
      const row = doc.createElement('div');
      row.setAttribute('data-test', 'milestone-row');
      row.innerHTML = `
        <input data-test="milestone-description" />
        <input data-test="milestone-due-date" />
        <input data-test="milestone-amount" />
      `;
      msContainer.appendChild(row);
    });
  }

  if (opts?.lockBid) {
    const bidEl = doc.querySelector<HTMLInputElement>("input[data-test='fixed-price-input']");
    bidEl?.addEventListener('input', () => {
      bidEl.value = '0';
    });
  }
  return doc;
}

describe('ProposalAdapter', () => {
  it('fills fixed proposal with Vue/Air3 native events, milestones, and screening answers', () => {
    const doc = buildProposalApplyDoc({ requiredQuestion: true });
    const events: string[] = [];
    const coverEl = doc.querySelector<HTMLTextAreaElement>(
      "textarea[data-test='cover-letter-textarea']",
    );
    coverEl?.addEventListener('input', () => events.push('input'));
    coverEl?.addEventListener('change', () => events.push('change'));
    coverEl?.addEventListener('blur', () => events.push('blur'));

    const res = fillProposalForm(
      doc,
      {
        upwork_job_id: '~022115332344639171',
        cover_letter: 'I can architect your Go + Postgres MCP server cleanly.',
        bid_type: 'fixed',
        bid_amount: 1400,
        boost_connects: 4,
        milestones: [
          { description: 'Phase 1', due_date: '2026-12-01', amount: 700 },
          { description: 'Phase 2', due_date: '2026-12-15', amount: 700 },
        ],
        screening_answers: [{ index: 0, answer: '7 years in production Go.' }],
      },
      undefined,
      {
        href: 'https://www.upwork.com/nx/proposals/job/~022115332344639171/apply/',
        pathname: '/nx/proposals/job/~022115332344639171/apply/',
      },
    );

    expect(res.ok).toBe(true);
    expect(events).toEqual(['input', 'change', 'blur']);
    expect(res.snapshot?.cover_letter_length).toBe(54);
    expect(res.snapshot?.bid_amount).toBe(1400);
    expect(res.snapshot?.estimated_fee).toBe(140);
    expect(res.snapshot?.estimated_net).toBe(1260);
    expect(res.snapshot?.connects_cost).toBe(12);
    expect(res.snapshot?.boost_connects).toBe(4);
    expect(res.snapshot?.total_connects).toBe(16);
    expect(res.snapshot?.unanswered_required_questions).toBe(0);

    const msRows = doc.querySelectorAll("[data-test='milestone-row']");
    expect(msRows.length).toBe(2);
    expect(
      (msRows[1].querySelector("input[data-test='milestone-description']") as HTMLInputElement)
        .value,
    ).toBe('Phase 2');
  });

  it('fills hourly rate and rate_increase_select cleanly', () => {
    const doc = buildProposalApplyDoc({ hourly: true });
    const res = fillProposalForm(
      doc,
      {
        upwork_job_id: '~022115332344639171',
        cover_letter: 'Ready for hourly engagement.',
        bid_type: 'hourly',
        bid_amount: 95,
        rate_increase: '3m',
      },
      undefined,
      {
        href: 'https://www.upwork.com/nx/proposals/job/~022115332344639171/apply/',
        pathname: '/nx/proposals/job/~022115332344639171/apply/',
      },
    );
    expect(res.ok).toBe(true);
    expect(res.snapshot?.bid_type).toBe('hourly');
    expect(res.snapshot?.bid_amount).toBe(95);
    expect(res.snapshot?.rate_increase).toBe('3m');
  });

  it('returns FILL_VERIFICATION_FAILED when reactive handler resets bid amount', () => {
    const doc = buildProposalApplyDoc({ lockBid: true });
    const res = fillProposalForm(
      doc,
      {
        upwork_job_id: '~022115332344639171',
        cover_letter: 'Hello',
        bid_type: 'fixed',
        bid_amount: 1400,
      },
      undefined,
      {
        href: 'https://www.upwork.com/nx/proposals/job/~022115332344639171/apply/',
        pathname: '/nx/proposals/job/~022115332344639171/apply/',
      },
    );
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('FILL_VERIFICATION_FAILED');
  });

  it('returns ALREADY_APPLIED and INSUFFICIENT_CONNECTS cleanly', () => {
    const appliedDoc = buildProposalApplyDoc({ alreadyApplied: true });
    const resApplied = fillProposalForm(
      appliedDoc,
      { upwork_job_id: '~1', cover_letter: 'Hi', bid_type: 'fixed' },
      undefined,
      {
        href: 'https://www.upwork.com/nx/proposals/job/~1/apply/',
        pathname: '/nx/proposals/job/~1/apply/',
      },
    );
    expect(resApplied.ok).toBe(false);
    expect(resApplied.errorCode).toBe('ALREADY_APPLIED');

    const lowConnDoc = buildProposalApplyDoc({ availableConnects: 10, requiredConnects: 12 });
    const resLow = fillProposalForm(
      lowConnDoc,
      { upwork_job_id: '~1', cover_letter: 'Hi', bid_type: 'fixed', boost_connects: 4 },
      undefined,
      {
        href: 'https://www.upwork.com/nx/proposals/job/~1/apply/',
        pathname: '/nx/proposals/job/~1/apply/',
      },
    );
    expect(resLow.ok).toBe(false);
    expect(resLow.errorCode).toBe('INSUFFICIENT_CONNECTS');
  });

  it('allows fill with unanswered required screening question, then blocks submit', () => {
    const doc = buildProposalApplyDoc({ requiredQuestion: true });
    const fillRes = fillProposalForm(
      doc,
      {
        upwork_job_id: '~022115332344639171',
        cover_letter: 'Hello there',
        bid_type: 'fixed',
        bid_amount: 1000,
      },
      undefined,
      {
        href: 'https://www.upwork.com/nx/proposals/job/~022115332344639171/apply/',
        pathname: '/nx/proposals/job/~022115332344639171/apply/',
      },
    );
    expect(fillRes.ok).toBe(true);
    expect(fillRes.snapshot?.unanswered_required_questions).toBe(1);

    const submitBtn = doc.querySelector<HTMLButtonElement>(
      "button[data-test='submit-proposal-btn']",
    );
    const clickSpy = vi.fn();
    submitBtn?.addEventListener('click', clickSpy);

    const submitRes = submitProposalForm(doc, { upwork_job_id: '~022115332344639171' }, undefined, {
      href: 'https://www.upwork.com/nx/proposals/job/~022115332344639171/apply/',
      pathname: '/nx/proposals/job/~022115332344639171/apply/',
    });
    expect(submitRes.ok).toBe(false);
    expect(submitRes.errorCode).toBe('SCREENING_QUESTIONS_REQUIRED');
    expect(clickSpy).not.toHaveBeenCalled();

    // Answer the required question and submit succeeds
    const ansEl = doc.querySelector<HTMLTextAreaElement>(
      "textarea[data-test='screening-answer-input']",
    );
    if (ansEl) ansEl.value = '8 years';
    const submitOk = submitProposalForm(doc, { upwork_job_id: '~022115332344639171' }, undefined, {
      href: 'https://www.upwork.com/nx/proposals/job/~022115332344639171/apply/',
      pathname: '/nx/proposals/job/~022115332344639171/apply/',
    });
    expect(submitOk.ok).toBe(true);
    expect(submitOk.clicked).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('extracts proposals list rows with normalized statuses', () => {
    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <nav data-test="nav-user-menu">User</nav>
        <table><tbody>
          <tr data-test="proposal-row" data-proposal-id="~990001" data-status="interviewing">
            <td><a data-test="proposal-job-link" href="/jobs/~022115332344639171">Go MCP Server</a></td>
            <td data-test="proposal-submitted-date">2026-11-18</td>
            <td data-test="proposal-bid">$1,400</td>
            <td data-test="proposal-connects">16</td>
            <td data-test="proposal-status">Interviewing</td>
          </tr>
          <tr data-test="proposal-row" data-proposal-id="~990002" data-status="offer">
            <td><a data-test="proposal-job-link" href="/jobs/~022999999999999999">Rust API</a></td>
            <td data-test="proposal-submitted-date">2026-11-19</td>
            <td data-test="proposal-bid">$2,500</td>
            <td data-test="proposal-connects">12</td>
            <td data-test="proposal-status">Offer received</td>
          </tr>
        </tbody></table>
      </body></html>`,
      'text/html',
    );
    const res = extractProposalsList(doc, undefined, {
      href: 'https://www.upwork.com/nx/proposals/',
      pathname: '/nx/proposals/',
    });
    expect(res.ok).toBe(true);
    expect(res.proposals).toHaveLength(2);
    expect(res.proposals[0]).toMatchObject({
      upwork_proposal_id: '~990001',
      upwork_job_id: '~022115332344639171',
      status: 'interviewing',
      bid_amount: 1400,
      connects: 16,
    });
    expect(res.proposals[1].status).toBe('offer');
  });

  it('returns FILL_VERIFICATION_FAILED when reactive blur clears screening answer or resets rate_increase/milestone', () => {
    const doc = buildProposalApplyDoc({ requiredQuestion: true });
    const qInput = doc.querySelector<HTMLTextAreaElement>(
      "textarea[data-test='screening-answer-input']",
    );
    qInput?.addEventListener('blur', () => {
      qInput.value = '';
    });

    const screeningRes = fillProposalForm(
      doc,
      {
        upwork_job_id: '~022115332344639171',
        cover_letter: 'I can architect your Go + Postgres MCP server cleanly.',
        bid_type: 'fixed',
        bid_amount: 1400,
        screening_answers: [{ index: 0, answer: '7 years in production Go.' }],
      },
      undefined,
      {
        href: 'https://www.upwork.com/nx/proposals/job/~022115332344639171/apply/',
        pathname: '/nx/proposals/job/~022115332344639171/apply/',
      },
    );
    expect(screeningRes.ok).toBe(false);
    expect(screeningRes.errorCode).toBe('FILL_VERIFICATION_FAILED');

    const hourlyDoc = buildProposalApplyDoc({ hourly: true });
    const rateSelect = hourlyDoc.querySelector<HTMLSelectElement>(
      "select[data-test='rate-increase-select']",
    );
    rateSelect?.addEventListener('blur', () => {
      rateSelect.value = '';
    });
    const rateRes = fillProposalForm(
      hourlyDoc,
      {
        upwork_job_id: '~022115332344639180',
        cover_letter: 'Ready for hourly work.',
        bid_type: 'hourly',
        bid_amount: 95,
        rate_increase: '3m',
      },
      undefined,
      {
        href: 'https://www.upwork.com/nx/proposals/job/~022115332344639180/apply/',
        pathname: '/nx/proposals/job/~022115332344639180/apply/',
      },
    );
    expect(rateRes.ok).toBe(false);
    expect(rateRes.errorCode).toBe('FILL_VERIFICATION_FAILED');

    const msDoc = buildProposalApplyDoc();
    const firstAmt = msDoc.querySelector<HTMLInputElement>("input[data-test='milestone-amount']");
    firstAmt?.addEventListener('blur', () => {
      firstAmt.value = '0';
    });
    const msRes = fillProposalForm(
      msDoc,
      {
        upwork_job_id: '~022115332344639171',
        cover_letter: 'Milestone test.',
        bid_type: 'fixed',
        bid_amount: 1000,
        milestones: [{ description: 'Phase 1', amount: 1000 }],
      },
      undefined,
      {
        href: 'https://www.upwork.com/nx/proposals/job/~022115332344639171/apply/',
        pathname: '/nx/proposals/job/~022115332344639171/apply/',
      },
    );
    expect(msRes.ok).toBe(false);
    expect(msRes.errorCode).toBe('FILL_VERIFICATION_FAILED');
  });

  it('breaks milestone add loop when row count does not increase and reads text on custom dropdown', () => {
    const doc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <nav class="air3-nav-freelancer"></nav>
        <form>
          <textarea data-test="cover-letter-textarea"></textarea>
          <input data-test="fixed-price-input" value="300" />
          <input type="radio" name="milestoneMode" value="milestone" />
          <button data-test="add-milestone-btn" type="button">Add</button>
          <div data-test="milestone-row">
            <input data-test="milestone-description" />
            <input data-test="milestone-amount" />
          </div>
          <button data-test="rate-increase-dropdown" type="button">5%</button>
        </form>
      </body></html>`,
      'text/html',
    );
    let clicks = 0;
    doc.querySelector("button[data-test='add-milestone-btn']")?.addEventListener('click', () => {
      clicks++;
    });
    const res = fillProposalForm(
      doc,
      {
        upwork_job_id: '~022115332344639171',
        cover_letter: 'Hi there',
        bid_type: 'fixed',
        bid_amount: 300,
        milestones: [
          { description: 'M1', amount: 100 },
          { description: 'M2', amount: 200 },
        ],
      },
      undefined,
      {
        href: 'https://www.upwork.com/nx/proposals/job/~022115332344639171/apply/',
        pathname: '/nx/proposals/job/~022115332344639171/apply/',
      },
    );
    expect(clicks).toBe(1);
    expect(res.snapshot?.rate_increase).toBe('5%');
  });

  it('fails closed with SELECTOR_BROKEN when requested bid_amount, boost_connects, rate_increase, or milestones lack DOM controls, while allowing omitted optional fields', () => {
    const bareDoc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <nav data-test="nav-user-menu">User</nav>
        <textarea data-test="cover-letter-textarea"></textarea>
        <button type="button" data-test="submit-proposal-btn">Submit</button>
      </body></html>`,
      'text/html',
    );
    const loc = {
      href: 'https://www.upwork.com/nx/proposals/job/~022115332344639171/apply/',
      pathname: '/nx/proposals/job/~022115332344639171/apply/',
    };

    // Omitting optional pricing/boost/rate_increase/milestones still succeeds
    const omittedRes = fillProposalForm(
      bareDoc,
      { upwork_job_id: '~022115332344639171', cover_letter: 'Clean cover letter.', bid_type: '' },
      undefined,
      loc,
    );
    expect(omittedRes.ok).toBe(true);

    // Explicit bid_amount without fixed/hourly input -> SELECTOR_BROKEN
    const missingBid = fillProposalForm(
      bareDoc,
      {
        upwork_job_id: '~022115332344639171',
        cover_letter: 'Clean cover letter.',
        bid_type: 'fixed',
        bid_amount: 1400,
      },
      undefined,
      loc,
    );
    expect(missingBid.ok).toBe(false);
    expect(missingBid.errorCode).toBe('SELECTOR_BROKEN');

    // Explicit boost_connects without boost input -> SELECTOR_BROKEN
    const withBidDoc = new DOMParser().parseFromString(
      `<!doctype html><html><body>
        <nav data-test="nav-user-menu">User</nav>
        <textarea data-test="cover-letter-textarea"></textarea>
        <input data-test="fixed-price-input" value="1000" />
        <button type="button" data-test="submit-proposal-btn">Submit</button>
      </body></html>`,
      'text/html',
    );
    const missingBoost = fillProposalForm(
      withBidDoc,
      {
        upwork_job_id: '~022115332344639171',
        cover_letter: 'Clean cover letter.',
        bid_type: 'fixed',
        bid_amount: 1400,
        boost_connects: 12,
      },
      undefined,
      loc,
    );
    expect(missingBoost.ok).toBe(false);
    expect(missingBoost.errorCode).toBe('SELECTOR_BROKEN');

    // Explicit rate_increase without rate_increase_dropdown -> SELECTOR_BROKEN
    const missingRateInc = fillProposalForm(
      withBidDoc,
      {
        upwork_job_id: '~022115332344639171',
        cover_letter: 'Clean cover letter.',
        bid_type: '',
        rate_increase: '3m',
      },
      undefined,
      loc,
    );
    expect(missingRateInc.ok).toBe(false);
    expect(missingRateInc.errorCode).toBe('SELECTOR_BROKEN');

    // Non-empty milestones without milestone rows -> SELECTOR_BROKEN
    const missingMilestones = fillProposalForm(
      withBidDoc,
      {
        upwork_job_id: '~022115332344639171',
        cover_letter: 'Clean cover letter.',
        bid_type: 'fixed',
        bid_amount: 1400,
        milestones: [{ description: 'Phase 1', amount: 1400 }],
      },
      undefined,
      loc,
    );
    expect(missingMilestones.ok).toBe(false);
    expect(missingMilestones.errorCode).toBe('SELECTOR_BROKEN');
  });
});
