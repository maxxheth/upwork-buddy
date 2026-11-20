import type { AuthState, SubmittedProposalRecord } from '../server/mock-types.ts';
import { escapeHtml, renderSharedAuthenticatedNav } from './challenge-fixtures.ts';
import { getJobDetailSpec } from './detail-fixtures.ts';

function stripCurrencyToNumber(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return fallback;
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num.toFixed(2) : fallback;
}

export function renderProposalApplyPage(
  jobId: string,
  url: URL,
  authState: AuthState,
  lockApplyBidFlag: boolean,
): { status: number; html: string } {
  const normalizedId = jobId.startsWith('~') ? jobId : `~${jobId}`;

  if (normalizedId === '~022115332344639404' || normalizedId === '~000000000000000404') {
    return {
      status: 200,
      html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Proposal Unavailable - Upwork</title></head>
<body>
${renderSharedAuthenticatedNav(authState)}
<main data-test="proposal-apply-page">
  <div data-test="already-applied-banner" class="air3-alert air3-alert-info">
    <h1>You have already submitted a proposal</h1>
    <p>This job is no longer accepting new proposals from your account.</p>
  </div>
</main>
</body>
</html>`,
    };
  }

  const job = getJobDetailSpec(normalizedId);
  const jobTitle = job?.title ?? `Upwork Job ${normalizedId}`;
  const isHourly = job?.bidType === 'hourly';
  const defaultBid = isHourly
    ? stripCurrencyToNumber(job?.hourlyMin, '85.00')
    : stripCurrencyToNumber(job?.fixedAmount, '1500.00');
  const baseConnects = job?.connectsRequired ?? 12;

  const connectsParam = url.searchParams.get('connects');
  const availableConnects =
    connectsParam !== null && Number.isFinite(Number.parseInt(connectsParam, 10))
      ? Number.parseInt(connectsParam, 10)
      : 50;

  const lockBid = lockApplyBidFlag || url.searchParams.get('lock_bid') === '1';

  const initialBidNum = Number.parseFloat(defaultBid);
  const initialFee = (initialBidNum * 0.1).toFixed(2);
  const initialNet = (initialBidNum * 0.9).toFixed(2);

  const termsHtml = isHourly
    ? `      <div data-test="hourly-terms">
        <label for="hourly-rate">Hourly Rate ($/hr)</label>
        <input id="hourly-rate" data-test="hourly-rate-input" type="number" step="0.01" value="${defaultBid}" />
        <label for="rate-increase">Schedule a rate increase</label>
        <select id="rate-increase" data-test="rate-increase-select">
          <option value="never">Never</option>
          <option value="3m">Every 3 months</option>
          <option value="6m">Every 6 months</option>
        </select>
      </div>`
    : `      <div data-test="fixed-terms">
        <label><input type="radio" name="milestoneMode" value="project" checked /> By project</label>
        <label><input type="radio" name="milestoneMode" value="milestone" /> By milestone</label>
        <label for="fixed-price">Bid Amount ($)</label>
        <input id="fixed-price" data-test="fixed-price-input" type="number" step="0.01" value="${defaultBid}" />
        <div data-test="milestones-container">
          <div class="milestone-row" data-test="milestone-row">
            <input data-test="milestone-description" placeholder="Milestone description" />
            <input data-test="milestone-due-date" type="date" />
            <input data-test="milestone-amount" type="number" step="0.01" />
          </div>
          <button type="button" data-test="add-milestone-btn">+ Add milestone</button>
        </div>
      </div>`;

  const questions = job?.screeningQuestions ?? [];
  const questionsHtml =
    questions.length > 0
      ? `    <section data-test="screening-questions-section" class="air3-card">
${questions
  .map(
    (
      q,
    ) => `      <div class="screening-question-item" data-test="screening-question-item" data-required="${q.required ? 'true' : 'false'}">
        <label data-test="question-prompt">${escapeHtml(q.prompt)}${q.required ? ' <span class="required">*</span>' : ''}</label>
        <textarea data-test="screening-answer-input" rows="3"></textarea>
        ${q.required ? '<span data-test="field-error" class="field-error" hidden>This screening question is required.</span>' : ''}
      </div>`,
  )
  .join('\n')}
    </section>`
      : '';

  return {
    status: 200,
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Submit a Proposal - Upwork</title></head>
<body>
${renderSharedAuthenticatedNav(authState)}
<main data-test="proposal-apply-page">
  <h1 data-test="proposal-job-title">${escapeHtml(jobTitle)}</h1>
  <div data-test="contract-type-badge">${isHourly ? 'Hourly' : 'Fixed price'}</div>

  <form id="proposal-apply-form" data-test="proposal-apply-form" novalidate>
    <section data-test="terms-section" class="air3-card">
${termsHtml}
      <div data-test="fee-preview">
        <span>10% Upwork Service Fee: <strong data-test="upwork-fee">-$${initialFee}</strong></span>
        <span>You'll receive: <strong data-test="estimated-earnings">$${initialNet}</strong></span>
      </div>
    </section>

    <section data-test="cover-letter-section" class="air3-card">
      <label for="cover-letter">Cover Letter <span class="required">*</span></label>
      <textarea id="cover-letter" data-test="cover-letter-textarea" rows="8"></textarea>
      <span data-test="cover-letter-error" class="field-error" hidden>Cover letter is required.</span>
    </section>

${questionsHtml}

    <section data-test="connects-section" class="air3-card">
      <div data-test="connects-required-cost">Required Connects: <strong data-test="required-connects-value">${baseConnects}</strong></div>
      <div data-test="available-connects">Available Connects: <strong>${availableConnects}</strong></div>
      <label for="boost-connects">Boost your proposal (optional Connects)</label>
      <input id="boost-connects" data-test="boost-connects-input" type="number" min="0" max="100" value="0" />
      <div data-test="total-connects-cost">Total Connects: <strong data-test="total-connects-value">${baseConnects}</strong></div>
    </section>

    <section data-test="attachments-section" class="air3-card">
      <input type="file" data-test="proposal-attachment-input" />
    </section>

    <div data-test="form-validation-error" class="air3-alert air3-alert-danger" hidden></div>
    <button type="button" data-test="submit-proposal-btn" class="air3-btn air3-btn-primary">Submit proposal</button>
  </form>
</main>
<script>
(() => {
  const jobId = ${JSON.stringify(normalizedId)};
  const bidType = ${JSON.stringify(isHourly ? 'hourly' : 'fixed')};
  const baseConnects = ${baseConnects};
  const availableConnects = ${availableConnects};
  const lockBid = ${lockBid ? 'true' : 'false'};
  const defaultBid = ${JSON.stringify(defaultBid)};
  const qCount = ${questions.length};

  const state = window.__mockProposalState = {
    jobId,
    bidType,
    bidAmount: defaultBid,
    rateIncrease: 'never',
    milestoneMode: 'project',
    milestones: [{ description: '', dueDate: '', amount: '' }],
    coverLetter: '',
    screeningAnswers: new Array(qCount).fill(''),
    boostConnects: 0,
    touched: {},
  };

  const feeEl = document.querySelector('[data-test="upwork-fee"]');
  const netEl = document.querySelector('[data-test="estimated-earnings"]');
  const totalConnectsEl = document.querySelector('[data-test="total-connects-value"]');

  function refreshDerived() {
    let base = parseFloat(state.bidAmount) || 0;
    if (bidType === 'fixed' && state.milestoneMode === 'milestone') {
      const mSum = state.milestones.reduce((acc, m) => acc + (parseFloat(m.amount) || 0), 0);
      if (mSum > 0) base = mSum;
    }
    const fee = (base * 0.10).toFixed(2);
    const net = (base * 0.90).toFixed(2);
    if (feeEl) feeEl.textContent = '-$' + fee;
    if (netEl) netEl.textContent = '$' + net;
    if (totalConnectsEl) {
      totalConnectsEl.textContent = String(baseConnects + (parseInt(state.boostConnects, 10) || 0));
    }
  }

  const bidInput = document.querySelector(
    bidType === 'hourly' ? '[data-test="hourly-rate-input"]' : '[data-test="fixed-price-input"]'
  );
  if (bidInput) {
    ['input', 'change'].forEach((evt) => {
      bidInput.addEventListener(evt, (e) => {
        if (lockBid) {
          bidInput.value = '0';
          state.bidAmount = '0';
        } else {
          state.bidAmount = e.target.value;
        }
        state.touched.bidAmount = true;
        refreshDerived();
      });
    });
    bidInput.addEventListener('blur', () => {
      if (lockBid) {
        bidInput.value = '0';
        state.bidAmount = '0';
        refreshDerived();
      }
    });
  }

  const rateIncreaseSelect = document.querySelector('[data-test="rate-increase-select"]');
  if (rateIncreaseSelect) {
    rateIncreaseSelect.addEventListener('change', (e) => {
      state.rateIncrease = e.target.value;
      state.touched.rateIncrease = true;
    });
  }

  document.querySelectorAll('input[name="milestoneMode"]').forEach((radio) => {
    radio.addEventListener('change', (e) => {
      state.milestoneMode = e.target.value;
      refreshDerived();
    });
  });

  function wireMilestoneRow(row, idx) {
    const desc = row.querySelector('[data-test="milestone-description"]');
    const due = row.querySelector('[data-test="milestone-due-date"]');
    const amt = row.querySelector('[data-test="milestone-amount"]');
    if (desc) {
      ['input', 'change'].forEach((evt) => desc.addEventListener(evt, (e) => {
        state.milestones[idx].description = e.target.value;
      }));
    }
    if (due) {
      ['input', 'change'].forEach((evt) => due.addEventListener(evt, (e) => {
        state.milestones[idx].dueDate = e.target.value;
      }));
    }
    if (amt) {
      ['input', 'change'].forEach((evt) => amt.addEventListener(evt, (e) => {
        state.milestones[idx].amount = e.target.value;
        refreshDerived();
      }));
    }
  }

  const milestonesContainer = document.querySelector('[data-test="milestones-container"]');
  if (milestonesContainer) {
    const firstRow = milestonesContainer.querySelector('[data-test="milestone-row"]');
    if (firstRow) wireMilestoneRow(firstRow, 0);
    const addBtn = milestonesContainer.querySelector('[data-test="add-milestone-btn"]');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        const idx = state.milestones.length;
        state.milestones.push({ description: '', dueDate: '', amount: '' });
        const row = document.createElement('div');
        row.className = 'milestone-row';
        row.setAttribute('data-test', 'milestone-row');
        row.innerHTML = '<input data-test="milestone-description" placeholder="Milestone description" />' +
          '<input data-test="milestone-due-date" type="date" />' +
          '<input data-test="milestone-amount" type="number" step="0.01" />';
        milestonesContainer.insertBefore(row, addBtn);
        wireMilestoneRow(row, idx);
      });
    }
  }

  const coverEl = document.querySelector('[data-test="cover-letter-textarea"]');
  if (coverEl) {
    ['input', 'change'].forEach((evt) => {
      coverEl.addEventListener(evt, (e) => {
        state.coverLetter = e.target.value;
        state.touched.coverLetter = true;
        const err = document.querySelector('[data-test="cover-letter-error"]');
        if (err) err.hidden = state.coverLetter.trim().length > 0;
      });
    });
  }

  const boostEl = document.querySelector('[data-test="boost-connects-input"]');
  if (boostEl) {
    ['input', 'change'].forEach((evt) => {
      boostEl.addEventListener(evt, (e) => {
        state.boostConnects = parseInt(e.target.value, 10) || 0;
        refreshDerived();
      });
    });
  }

  const qItems = Array.from(document.querySelectorAll('[data-test="screening-question-item"]'));
  qItems.forEach((item, idx) => {
    const ta = item.querySelector('[data-test="screening-answer-input"]');
    if (ta) {
      ['input', 'change'].forEach((evt) => {
        ta.addEventListener(evt, (e) => {
          state.screeningAnswers[idx] = e.target.value;
          const err = item.querySelector('[data-test="field-error"]');
          if (err) err.hidden = e.target.value.trim().length > 0;
        });
      });
    }
  });

  const submitBtn = document.querySelector('[data-test="submit-proposal-btn"]');
  if (submitBtn) {
    submitBtn.addEventListener('click', async () => {
      const errors = [];
      if (!state.coverLetter.trim()) {
        const err = document.querySelector('[data-test="cover-letter-error"]');
        if (err) err.hidden = false;
        errors.push('Cover letter missing from reactive state');
      }
      qItems.forEach((item, idx) => {
        if (item.dataset.required === 'true' && !(state.screeningAnswers[idx] || '').trim()) {
          const err = item.querySelector('[data-test="field-error"]');
          if (err) err.hidden = false;
          errors.push('Required screening question #' + (idx + 1) + ' unanswered in reactive state');
        }
      });
      const totalConnects = baseConnects + (parseInt(state.boostConnects, 10) || 0);
      if (totalConnects > availableConnects) {
        errors.push('Insufficient Connects (' + totalConnects + ' required, ' + availableConnects + ' available)');
      }
      if (bidType === 'fixed' && state.milestoneMode === 'milestone') {
        const validMilestone = state.milestones.some(
          (m) => m.description.trim().length > 0 && (parseFloat(m.amount) || 0) > 0
        );
        if (!validMilestone) {
          errors.push('At least one valid milestone is required');
        }
      }
      const banner = document.querySelector('[data-test="form-validation-error"]');
      if (errors.length > 0) {
        if (banner) {
          banner.textContent = errors.join('; ');
          banner.hidden = false;
        }
        return;
      }
      if (banner) banner.hidden = true;
      const res = await fetch('/api/mock/proposals/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(state),
      });
      const data = await res.json();
      if (data.ok && data.redirectUrl) {
        window.location.href = data.redirectUrl;
      }
    });
  }
})();
</script>
</body>
</html>`,
  };
}

export function renderProposalConfirmationPage(authState: AuthState, jobId?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Proposal Submitted - Upwork</title></head>
<body>
${renderSharedAuthenticatedNav(authState)}
<main data-test="proposal-confirmation-page"${jobId ? ` data-job-id="${escapeHtml(jobId)}"` : ''}>
  <div data-test="proposal-submitted-banner" class="air3-alert air3-alert-success">
    <h1>Your proposal was submitted!</h1>
    <p>You will be notified when the client views or responds to your proposal.</p>
    <a data-test="view-proposal-link" href="/nx/proposals/">View submitted proposals</a>
  </div>
</main>
</body>
</html>`;
}

export function renderProposalsDashboardPage(
  authState: AuthState,
  submittedProposals: SubmittedProposalRecord[],
): string {
  const dynamicSubmittedRows = submittedProposals
    .map((p) => {
      const detail = getJobDetailSpec(p.jobId);
      const title = detail?.title ?? `Proposal for ${p.jobId}`;
      const slug = detail?.slug ?? 'Job';
      const bidText = p.bidType === 'hourly' ? `$${p.bidAmount}/hr` : `$${p.bidAmount}`;
      const connects = (detail?.connectsRequired ?? 10) + p.boostConnects;
      return `        <tr data-test="proposal-row" data-proposal-id="${escapeHtml(p.proposalId)}" data-status="submitted">
          <td><a data-test="proposal-job-link" href="/jobs/${escapeHtml(slug)}_${escapeHtml(p.jobId)}/">${escapeHtml(title)}</a></td>
          <td data-test="proposal-submitted-date">Nov 19, 2026</td>
          <td data-test="proposal-bid">${escapeHtml(bidText)}</td>
          <td data-test="proposal-connects">${connects} Connects</td>
          <td data-test="proposal-status"><span class="air3-badge">Submitted</span></td>
        </tr>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>My Proposals - Upwork</title></head>
<body>
${renderSharedAuthenticatedNav(authState)}
<main data-test="proposals-dashboard">
  <h1>My Proposals</h1>
  <section data-test="proposals-section-active">
    <h2>Active proposals</h2>
    <table data-test="proposals-table">
      <tbody>
        <tr data-test="proposal-row" data-proposal-id="~990001" data-status="interviewing">
          <td><a data-test="proposal-job-link" href="/jobs/On-Page-SEO-Expert-Audit_~022115332344639171/">On-Page SEO Expert Needed</a></td>
          <td data-test="proposal-submitted-date">Nov 18, 2026</td>
          <td data-test="proposal-bid">$1,500.00</td>
          <td data-test="proposal-connects">12 Connects</td>
          <td data-test="proposal-status"><span class="air3-badge">Interviewing</span></td>
        </tr>
        <tr data-test="proposal-row" data-proposal-id="~990002" data-status="offer">
          <td><a data-test="proposal-job-link" href="/jobs/Website-Migration_~022111887415567641942/">Full Website Migration</a></td>
          <td data-test="proposal-submitted-date">Nov 17, 2026</td>
          <td data-test="proposal-bid">$1,000.00</td>
          <td data-test="proposal-connects">8 Connects</td>
          <td data-test="proposal-status"><span class="air3-badge">Offer received</span></td>
        </tr>
        <tr data-test="proposal-row" data-proposal-id="~990006" data-status="offer">
          <td><a data-test="proposal-job-link" href="/jobs/Won-Offer-Laravel-Go-Platform_~07won/">Won Offer: Go &amp; TypeScript Delivery Platform</a></td>
          <td data-test="proposal-submitted-date">Nov 19, 2026</td>
          <td data-test="proposal-bid">$4,000.00</td>
          <td data-test="proposal-connects">12 Connects</td>
          <td data-test="proposal-status"><span class="air3-badge">Offer received</span></td>
        </tr>
      </tbody>
    </table>
  </section>
  <section data-test="proposals-section-submitted">
    <h2>Submitted proposals</h2>
    <table data-test="proposals-table">
      <tbody>
        <tr data-test="proposal-row" data-proposal-id="~990003" data-status="submitted">
          <td><a data-test="proposal-job-link" href="/jobs/Python-FastAPI_~022111887415567641941/">Python FastAPI Microservices Architect</a></td>
          <td data-test="proposal-submitted-date">Nov 19, 2026</td>
          <td data-test="proposal-bid">$2,500.00</td>
          <td data-test="proposal-connects">12 Connects</td>
          <td data-test="proposal-status"><span class="air3-badge">Submitted</span></td>
        </tr>
        <tr data-test="proposal-row" data-proposal-id="~990004" data-status="viewed">
          <td><a data-test="proposal-job-link" href="/jobs/Senior-Go-Backend_~022111887415567642001/">Senior Go &amp; PostgreSQL Backend Engineer</a></td>
          <td data-test="proposal-submitted-date">Nov 18, 2026</td>
          <td data-test="proposal-bid">$90.00/hr</td>
          <td data-test="proposal-connects">12 Connects</td>
          <td data-test="proposal-status"><span class="air3-badge">Viewed by client</span></td>
        </tr>
${dynamicSubmittedRows}
      </tbody>
    </table>
  </section>
  <section data-test="proposals-section-archived">
    <h2>Archived proposals</h2>
    <table data-test="proposals-table">
      <tbody>
        <tr data-test="proposal-row" data-proposal-id="~990005" data-status="archived">
          <td><a data-test="proposal-job-link" href="/jobs/Legacy-Task_~022111887415567641944/">Legacy Placeholder Budget Task</a></td>
          <td data-test="proposal-submitted-date">Nov 01, 2026</td>
          <td data-test="proposal-bid">$0.00</td>
          <td data-test="proposal-connects">4 Connects</td>
          <td data-test="proposal-status"><span class="air3-badge">Archived</span></td>
        </tr>
      </tbody>
    </table>
  </section>
</main>
</body>
</html>`;
}
