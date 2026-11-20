import type { AuthState, DriftMode, MockServerConfig } from '../server/mock-types.ts';
import { escapeHtml, renderSharedAuthenticatedNav } from './challenge-fixtures.ts';
import { getJobDetailSpec, renderJobDetailsContentInner } from './detail-fixtures.ts';
import { renderUnmappedAuthHooks, resolveEffectiveDriftMode } from './drift-fixtures.ts';

export interface SearchCardSpec {
  id: string;
  href: string;
  titleHtml: string;
  omitTitle?: boolean;
  postedText: string;
  useTypoPosted?: boolean;
  jobTypeLabel: string;
  fixedBudgetText?: string;
  experienceLevel: string;
  durationText?: string;
  descriptionHtml: string;
  omitDescriptionParagraph?: boolean;
  skills: string[];
  clientLocation?: string;
  clientRating?: string;
  clientSpend?: string;
  proposalsTier?: string;
  paymentVerified?: boolean;
  extraCardHtml?: string;
}

function buildBaselinePage1Cards(): SearchCardSpec[] {
  return [
    {
      id: '~022115332344639171',
      href: '/jobs/On-Page-SEO-Expert-Audit-span-class-highlight-WordPress-span-amp-Elementor_~022115332344639171/?referrer_url_path=/nx/search/jobs/',
      titleHtml:
        'On-Page SEO Expert Needed — Audit + <span class="highlight">WordPress</span>/Elementor Implementation',
      postedText: 'Posted 2 hours ago',
      useTypoPosted: true,
      jobTypeLabel: 'Fixed price',
      fixedBudgetText: '$1,500.00',
      experienceLevel: 'Expert',
      durationText: '1 to 3 months, Less than 30 hrs/week',
      descriptionHtml:
        'We are looking for an experienced <span class="highlight">WordPress</span> developer to rebuild our 25-35 page HVAC site (<span class="highlight">WordPress</span>, Elementor) with a focus on local SEO.',
      skills: ['WordPress', 'Elementor', 'SEO'],
      clientLocation: 'United States',
      clientRating: '4.95 of 5 stars',
      clientSpend: '$120K total spent',
      proposalsTier: 'Less than 5',
      paymentVerified: true,
    },
    {
      id: '~022111887415567641942',
      href: '/jobs/Website-Migration-GoDaddy--Host-span-class-highlight-WordPress-span-amp-CDN_~022111887415567641942/',
      titleHtml: 'Full Website Migration (GoDaddy to <span class="highlight">WordPress</span>)',
      postedText: 'Posted yesterday',
      useTypoPosted: false,
      jobTypeLabel: 'Fixed price',
      fixedBudgetText: '$1,000.00',
      experienceLevel: 'Intermediate',
      durationText: 'Less than 1 month, Less than 30 hrs/week',
      descriptionHtml:
        '<span class="highlight">WordPress</span> site needs moving off GoDaddy hosting.',
      skills: ['WordPress', 'Cloudflare'],
      clientLocation: 'United Kingdom',
      clientRating: '4.8 of 5 stars',
      clientSpend: '$12K total spent',
      proposalsTier: 'Less than 5',
      paymentVerified: true,
    },
    {
      id: '~022111887415567641941',
      href: '/jobs/Python-Engineer-span-class-highlight-FastAPI-span_~022111887415567641941/?referrer_url_path=/nx/search/jobs/',
      titleHtml: 'Python FastAPI Microservices Architect',
      postedText: 'Posted 3 hours ago',
      useTypoPosted: true,
      jobTypeLabel: 'Fixed price',
      experienceLevel: 'Expert',
      durationText: '1 to 3 months, 30+ hrs/week',
      descriptionHtml: 'Build scalable REST APIs using FastAPI and PostgreSQL.',
      skills: ['Python', 'FastAPI', 'PostgreSQL'],
      clientLocation: 'Canada',
      clientRating: '5.0 of 5 stars',
      clientSpend: '10k total spent',
      proposalsTier: '10 to 15',
      paymentVerified: true,
    },
    {
      id: '~022111887415567641944',
      href: '/jobs/Legacy-Placeholder-Budget-Task_~022111887415567641944/',
      titleHtml: 'Legacy Placeholder Budget Task',
      postedText: 'Posted 2 weeks ago',
      useTypoPosted: false,
      jobTypeLabel: 'Fixed price',
      fixedBudgetText: '$0.00',
      experienceLevel: 'Entry level',
      durationText: 'Less than 1 month',
      descriptionHtml: 'Placeholder zero budget task for filter edge case testing.',
      skills: ['HTML'],
      clientLocation: 'Australia',
      clientRating: '4.2 of 5 stars',
      proposalsTier: '50+',
      paymentVerified: false,
    },
  ];
}

function buildBaselinePage2Cards(): SearchCardSpec[] {
  return [
    buildBaselinePage1Cards()[0],
    {
      id: '~022115332344639180',
      href: '/jobs/Senior-Go-Systems-Consultant-Hourly_~022115332344639180/',
      titleHtml: 'Senior Go Systems Consultant (Hourly)',
      postedText: 'Posted 4 hours ago',
      useTypoPosted: false,
      jobTypeLabel: 'Hourly: $85.00',
      experienceLevel: 'Expert',
      durationText: '3 to 6 months, 30+ hrs/week',
      descriptionHtml: 'Seeking a senior Go systems consultant for ongoing backend tuning.',
      skills: ['Go', 'PostgreSQL', 'Docker'],
      clientLocation: 'United States',
      clientRating: '4.9 of 5 stars',
      clientSpend: '$60K total spent',
      proposalsTier: 'Less than 5',
      paymentVerified: true,
    },
    {
      id: '~022111887415567642002',
      href: '/jobs/AI-Agent-Integration-MCP-TypeScript_~022111887415567642002/',
      titleHtml: 'AI Agent Integration with MCP &amp; TypeScript',
      postedText: 'Posted 1 hour ago',
      useTypoPosted: false,
      jobTypeLabel: 'Fixed price',
      fixedBudgetText: '$1,800.00',
      experienceLevel: 'Expert',
      durationText: '1 to 3 months, 30+ hrs/week',
      descriptionHtml: 'Integrate typed MCP tool servers with TypeScript browser extensions.',
      skills: ['TypeScript', 'AI', 'Node.js'],
      clientLocation: 'United States',
      clientRating: '4.95 of 5 stars',
      clientSpend: '$30K total spent',
      proposalsTier: '5 to 10',
      paymentVerified: true,
    },
  ];
}

function buildPageNCard(page: number): SearchCardSpec[] {
  const idMap: Record<number, string> = {
    3: '~022111887415567642003',
    4: '~022111887415567642004',
    5: '~022111887415567642005',
  };
  const id = idMap[page] ?? `~02211188741556764200${page}`;
  const detail = getJobDetailSpec(id);
  return [
    {
      id,
      href: `/jobs/${detail?.slug ?? `WordPress-Task-Page-${page}`}_${id}/`,
      titleHtml: escapeHtml(detail?.title ?? `WordPress Page ${page} Job`),
      postedText: detail?.posted ?? `Posted ${page} hours ago`,
      useTypoPosted: false,
      jobTypeLabel: 'Fixed price',
      fixedBudgetText: detail?.fixedAmount ?? '$1,000.00',
      experienceLevel: detail?.experienceLevel ?? 'Intermediate',
      durationText: detail?.duration ?? '1 to 3 months',
      descriptionHtml: 'WordPress project listing on paginated results.',
      skills: detail?.skills ?? ['WordPress'],
      clientLocation: detail?.clientCountry ?? 'United States',
      clientRating: '4.8 of 5 stars',
      proposalsTier: detail?.proposalsTier ?? '5 to 10',
      paymentVerified: true,
    },
  ];
}

function renderCard(
  card: SearchCardSpec,
  index: number,
  authState: AuthState,
  driftMode: DriftMode,
  omitDomClientMetrics: boolean,
): string {
  const isV2Card = driftMode === 'broken_v2_card';
  const cardTag = isV2Card ? 'section' : 'article';
  const cardAttrs = isV2Card
    ? `data-test="v2-job-card" data-job-id="${escapeHtml(card.id)}"`
    : `class="job-tile air3-card air3-card-list" data-test="JobTile" data-job-id="${escapeHtml(card.id)}"`;

  const postedAttr = (() => {
    if (
      driftMode === 'clean_no_fragile' ||
      driftMode === 'broken_typo_fixed' ||
      driftMode === 'mutated_drift' ||
      driftMode === 'broken_missing'
    ) {
      return 'job-published-date';
    }
    if (driftMode === 'fragile') {
      return 'job-pubilshed-date';
    }
    return card.useTypoPosted ? 'job-pubilshed-date' : 'job-published-date';
  })();

  let titleAnchorHtml = '';
  if (!card.omitTitle) {
    if (driftMode === 'broken_missing') {
      titleAnchorHtml = `<a data-test="title-and-url" href="${escapeHtml(card.href)}">${card.titleHtml}</a>`;
    } else if (driftMode === 'broken_search') {
      titleAnchorHtml = `<a data-test="new-title-link" href="${escapeHtml(card.href)}">${card.titleHtml}</a>`;
    } else if (driftMode === 'broken_v2_card') {
      titleAnchorHtml = `<a data-qa="v2-title-anchor" href="${escapeHtml(card.href)}">${card.titleHtml}</a>`;
    } else {
      titleAnchorHtml = `<a data-test="job-tile-title-link UpCLink" class="air3-link air3-link-primary" href="${escapeHtml(card.href)}">${card.titleHtml}</a>`;
    }
  }

  const showJobType = driftMode !== 'degraded_low_cards' || index === 0;
  const expText = driftMode === 'degraded_empty_text' ? '   ' : card.experienceLevel;

  const showPrimaryDescParagraph =
    !card.omitDescriptionParagraph &&
    driftMode !== 'degraded_fallback' &&
    !(driftMode === 'mutated_drift' && index > 0);

  const descriptionBlock = showPrimaryDescParagraph
    ? `<div data-test="UpCLineClamp JobDescription">
          <div class="air3-line-clamp-wrapper"><div class="air3-line-clamp">
            <p class="mb-0 text-body-sm">${card.descriptionHtml}</p>
          </div></div>
        </div>`
    : `<div data-test="JobDescription">${card.descriptionHtml}</div>`;

  const skillsList =
    driftMode === 'mutated_drift' ? (index < 2 ? card.skills.slice(0, 1) : []) : card.skills;

  const skillsHtml =
    skillsList.length > 0
      ? `<div data-test="TokenClamp JobAttrs" class="skills-list air3-token-wrap">
${skillsList
  .map((skill) =>
    driftMode === 'degraded_fallback'
      ? `          <span class="air3-token"><span>${escapeHtml(skill)}</span></span>`
      : `          <button type="button" class="air3-token" data-test="token"><span>${escapeHtml(skill)}</span></button>`,
  )
  .join('\n')}
        </div>`
      : '';

  const locationValue = driftMode === 'mutated_drift' ? '' : (card.clientLocation ?? '');
  const ratingBlock =
    card.clientRating && authState === 'authenticated'
      ? driftMode === 'degraded_fallback'
        ? `          <span data-test="client-rating">${escapeHtml(card.clientRating)}</span>`
        : `          <span data-qa="client-rating">${escapeHtml(card.clientRating)}</span>`
      : '';

  const proposalsBlock =
    card.proposalsTier && authState === 'authenticated'
      ? driftMode === 'degraded_fallback' || driftMode === 'mutated_drift'
        ? `          <span data-test="proposals"><strong>${escapeHtml(card.proposalsTier)}</strong></span>`
        : `          <span data-test="proposals-tier"><strong>${escapeHtml(card.proposalsTier)}</strong></span>`
      : '';

  const authMetaBlock =
    authState === 'authenticated'
      ? `<div class="job-tile-auth-meta">
          ${!omitDomClientMetrics && card.paymentVerified ? '<span data-qa="payment-verified" data-test="payment-verified">Payment Verified</span>' : ''}
          ${card.clientLocation !== undefined ? `<span data-qa="client-location">${escapeHtml(locationValue)}</span>` : ''}
          ${ratingBlock}
          ${card.clientSpend ? `<span data-qa="client-spend">${escapeHtml(card.clientSpend)}</span>` : ''}
          ${proposalsBlock}
        </div>`
      : '';

  const fixedBudgetBlock =
    card.fixedBudgetText && driftMode !== 'mutated_drift'
      ? `          <li data-test="is-fixed-price"><span>Est. budget:</span><strong>${escapeHtml(card.fixedBudgetText)}</strong></li>`
      : '';

  const durationBlock =
    card.durationText && driftMode !== 'mutated_drift'
      ? `          <li data-test="duration-label"><strong>Est. time:</strong><span>${escapeHtml(card.durationText)}</span></li>`
      : '';

  const mutatedExtra =
    driftMode === 'mutated_drift'
      ? `<div class="mutated-drift-hooks">
          <span data-test="payment-verified-badge">Payment verified</span>
          <span data-test="connects-badge"></span>
          <span data-test="ai-match-badge">94% AI Match</span>
          ${index < 3 ? '<span data-test="brand-new-hook">New Hook</span>' : ''}
        </div>`
      : '';

  return `    <${cardTag} ${cardAttrs}>
      <div data-test="JobTileHeader">
        <div data-test="JobTile15in24Header">
          <small data-test="${postedAttr}"><span>${escapeHtml(card.postedText)}</span></small>
        </div>
        <h2>
          ${titleAnchorHtml}
        </h2>
      </div>
      <div data-test="JobTileDetails">
        <ul data-test="JobInfo">
          ${showJobType ? `<li data-test="job-type-label"><strong>${escapeHtml(card.jobTypeLabel)}</strong></li>` : ''}
          ${card.experienceLevel ? `<li data-test="experience-level"><strong>${escapeHtml(expText)}</strong></li>` : ''}
${fixedBudgetBlock}
${durationBlock}
        </ul>
        ${descriptionBlock}
        ${skillsHtml}
        ${authMetaBlock}
        ${mutatedExtra}
        ${card.extraCardHtml ?? ''}
      </div>
      <button type="button" class="air3-btn" data-test="open-drawer-btn" data-job-drawer="${escapeHtml(card.id)}">Quick View</button>
    </${cardTag}>`;
}

function buildCardsForSearchQuery(
  q: string,
  page: number,
  config: MockServerConfig,
): { cards: SearchCardSpec[]; totalPages: number; countText: string } {
  const lower = q.trim().toLowerCase();

  if (lower === 'empty') {
    return { cards: [], totalPages: 1, countText: '0 jobs found' };
  }

  if (lower === 'elementor') {
    return {
      totalPages: 1,
      countText: '2 jobs found',
      cards: [
        {
          id: '~022111887415567643001',
          href: '/jobs/Elementor-Custom-Widget-Kit_~022111887415567643001/',
          titleHtml: '<span class="highlight">Elementor</span> Custom Widget Kit Development',
          postedText: 'Posted 2 hours ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$1,400.00',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months',
          descriptionHtml: 'Build reusable <span class="highlight">Elementor</span> widgets.',
          skills: ['Elementor', 'WordPress', 'CSS'],
          clientLocation: 'United States',
          clientRating: '4.9 of 5 stars',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
        {
          id: '~022111887415567643002',
          href: '/jobs/Elementor-Speed-Audit-LCP-Fix_~022111887415567643002/',
          titleHtml: '<span class="highlight">Elementor</span> Speed Audit &amp; LCP Fix',
          postedText: 'Posted 3 hours ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$900.00',
          experienceLevel: 'Intermediate',
          durationText: 'Less than 1 month',
          descriptionHtml: 'Optimize LCP on an <span class="highlight">Elementor</span> site.',
          skills: ['Elementor', 'Performance'],
          clientLocation: 'United Kingdom',
          clientRating: '4.8 of 5 stars',
          proposalsTier: '5 to 10',
          paymentVerified: true,
        },
      ],
    };
  }

  if (lower === 'golang') {
    return {
      totalPages: 1,
      countText: '3 jobs found',
      cards: [
        {
          id: '~030100000000000000001',
          href: '/jobs/Senior-Golang-Microservices-Engineer_~030100000000000000001/',
          titleHtml: 'Senior <span class="highlight">Golang</span> Microservices Engineer',
          postedText: 'Posted 1 hour ago',
          jobTypeLabel: 'Fixed price',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months',
          descriptionHtml:
            'Architect and maintain production <span class="highlight">Golang</span> microservices backed by PostgreSQL.',
          skills: ['Go', 'Golang', 'PostgreSQL'],
          clientLocation: 'United States',
          clientRating: '4.9 of 5',
          clientSpend: '$80K total spent',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
        {
          id: '~030100000000000000002',
          href: '/jobs/Golang-Script-Fix_~030100000000000000002/',
          titleHtml: '<span class="highlight">Golang</span> Script Fix',
          postedText: 'Posted 3 hours ago',
          jobTypeLabel: 'Fixed price',
          experienceLevel: 'Entry level',
          durationText: 'Less than 1 month',
          descriptionHtml: 'Fix a small <span class="highlight">Golang</span> CLI parsing bug.',
          skills: ['Go', 'Golang'],
          clientLocation: 'United States',
          clientRating: '4.6 of 5',
          proposalsTier: '5 to 10',
          paymentVerified: true,
        },
        {
          id: '~030100000000000000003',
          href: '/jobs/Golang-Placeholder-Task_~030100000000000000003/',
          titleHtml: '<span class="highlight">Golang</span> Placeholder Task',
          postedText: 'Posted 5 hours ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$0.00',
          experienceLevel: 'Intermediate',
          durationText: 'Less than 1 month',
          descriptionHtml: 'Placeholder <span class="highlight">Golang</span> task with $0 budget.',
          skills: ['Go', 'Golang'],
          clientLocation: 'United States',
          clientRating: '4.5 of 5',
          proposalsTier: '10 to 15',
          paymentVerified: true,
        },
      ],
    };
  }

  if (lower === 'go postgresql') {
    return {
      totalPages: 1,
      countText: '2 jobs found',
      cards: [
        {
          id: '~033000000000000000001',
          href: '/jobs/Full-Stack-span-class-highlight-Go-span-TypeScript_~033000000000000000001/?referrer_url_path=/nx/search/jobs/',
          titleHtml:
            'Full-Stack <span class="highlight">Go</span> &amp; TypeScript Extension Developer',
          postedText: 'Posted 1 hour ago',
          jobTypeLabel: 'Hourly: $90.00 - $115.00',
          experienceLevel: 'Expert',
          durationText: '3 to 6 months, 30+ hrs/week',
          descriptionHtml:
            'Build a WXT MV3 extension paired with <span class="highlight">Go</span> and <span class="highlight">PostgreSQL</span>.',
          skills: ['Go', 'TypeScript', 'PostgreSQL'],
          clientLocation: 'United States',
          clientRating: '4.95 of 5 stars',
          clientSpend: '$95K total spent',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
        {
          id: '~040100000000000000002',
          href: '/jobs/span-class-highlight-Go-span-amp-PostgreSQL-Automation_~040100000000000000002/?referrer_url_path=/nx/search/jobs/',
          titleHtml:
            '<span class="highlight">Go</span> &amp; <span class="highlight">PostgreSQL</span> Automation Platform',
          postedText: 'Posted 30 minutes ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$2,200.00',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months, 30+ hrs/week',
          descriptionHtml:
            'Senior <span class="highlight">Go</span> and <span class="highlight">PostgreSQL</span> workflow engine.',
          skills: ['Go', 'PostgreSQL', 'TypeScript'],
          clientLocation: 'United States',
          clientRating: '4.95 of 5 stars',
          clientSpend: '$110K total spent',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
      ],
    };
  }

  if (lower === 'react') {
    const reactCards: SearchCardSpec[] =
      page === 2
        ? [
            {
              id: '~040200000000000000003',
              href: '/jobs/React-State-Refactor-P2_~040200000000000000003/',
              titleHtml: '<span class="highlight">React</span> State Management Refactor',
              postedText: 'Posted 3 hours ago',
              jobTypeLabel: 'Fixed price',
              fixedBudgetText: '$1,600.00',
              experienceLevel: 'Intermediate',
              durationText: '1 to 3 months',
              descriptionHtml: 'Simplify <span class="highlight">React</span> client state.',
              skills: ['React', 'TypeScript'],
              clientLocation: 'United States',
              clientRating: '4.9 of 5 stars',
              proposalsTier: 'Less than 5',
              paymentVerified: true,
            },
            {
              id: '~040200000000000000004',
              href: '/jobs/React-Performance-Audit-P2_~040200000000000000004/',
              titleHtml: '<span class="highlight">React</span> Rendering Performance Audit',
              postedText: 'Posted 4 hours ago',
              jobTypeLabel: 'Fixed price',
              fixedBudgetText: '$1,100.00',
              experienceLevel: 'Expert',
              durationText: 'Less than 1 month',
              descriptionHtml: 'Profile <span class="highlight">React</span> rendering.',
              skills: ['React', 'Performance'],
              clientLocation: 'United Kingdom',
              clientRating: '4.8 of 5 stars',
              proposalsTier: '5 to 10',
              paymentVerified: true,
            },
          ]
        : [
            {
              id: '~040200000000000000001',
              href: '/jobs/React-Dashboard-Modernization-P1_~040200000000000000001/',
              titleHtml: '<span class="highlight">React</span> Dashboard Modernization',
              postedText: 'Posted 1 hour ago',
              jobTypeLabel: 'Fixed price',
              fixedBudgetText: '$1,500.00',
              experienceLevel: 'Expert',
              durationText: '1 to 3 months',
              descriptionHtml: 'Upgrade <span class="highlight">React</span> analytics dashboard.',
              skills: ['React', 'TypeScript'],
              clientLocation: 'United States',
              clientRating: '4.9 of 5 stars',
              proposalsTier: 'Less than 5',
              paymentVerified: true,
            },
            {
              id: '~040200000000000000002',
              href: '/jobs/React-Component-Library-P1_~040200000000000000002/',
              titleHtml: '<span class="highlight">React</span> Accessible Component Library',
              postedText: 'Posted 2 hours ago',
              jobTypeLabel: 'Fixed price',
              fixedBudgetText: '$1,900.00',
              experienceLevel: 'Expert',
              durationText: '1 to 3 months',
              descriptionHtml: 'Build accessible <span class="highlight">React</span> primitives.',
              skills: ['React', 'Accessibility'],
              clientLocation: 'Canada',
              clientRating: '4.85 of 5 stars',
              proposalsTier: '5 to 10',
              paymentVerified: true,
            },
          ];
    return {
      cards: reactCards,
      totalPages: Math.max(config.totalSearchPages, 2),
      countText: '4 jobs found',
    };
  }

  if (lower === 'python') {
    const startIdx = (page - 1) * 2 + 1;
    const cards: SearchCardSpec[] = [];
    for (let offset = 0; offset < 2; offset += 1) {
      const idx = startIdx + offset;
      if (idx > 10) break;
      const padded = String(idx).padStart(2, '0');
      const id = `~0404000000000000000${padded}`;
      cards.push({
        id,
        href: `/jobs/Python-Backend-Worker-${idx}_${id}/`,
        titleHtml: `<span class="highlight">Python</span> Automation Engineer #${idx}`,
        postedText: `Posted ${idx} hours ago`,
        jobTypeLabel: 'Fixed price',
        fixedBudgetText: `$${1000 + idx * 100}.00`,
        experienceLevel: 'Expert',
        durationText: '1 to 3 months',
        descriptionHtml: `<span class="highlight">Python</span> data pipeline project #${idx}.`,
        skills: ['Python', 'PostgreSQL', 'Docker'],
        clientLocation: 'United States',
        clientRating: '4.9 of 5 stars',
        proposalsTier: 'Less than 5',
        paymentVerified: true,
      });
    }
    return {
      cards,
      totalPages: Math.max(config.totalSearchPages, 5),
      countText: '10 jobs found',
    };
  }

  if (lower === 'typescript') {
    return {
      totalPages: 1,
      countText: '2 jobs found',
      cards: [
        {
          id: '~040600000000000000001',
          href: '/jobs/TypeScript-SDK-Architecture_~040600000000000000001/',
          titleHtml: '<span class="highlight">TypeScript</span> SDK Architecture &amp; Testing',
          postedText: 'Posted 1 hour ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$2,000.00',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months',
          descriptionHtml: 'Design a strict <span class="highlight">TypeScript</span> SDK.',
          skills: ['TypeScript', 'Vitest'],
          clientLocation: 'United States',
          clientRating: '4.9 of 5 stars',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
        {
          id: '~040600000000000000002',
          href: '/jobs/TypeScript-Playwright-Harness_~040600000000000000002/',
          titleHtml: '<span class="highlight">TypeScript</span> Playwright Test Harness',
          postedText: 'Posted 2 hours ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$1,700.00',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months',
          descriptionHtml: 'Implement <span class="highlight">TypeScript</span> Playwright suites.',
          skills: ['TypeScript', 'Playwright'],
          clientLocation: 'Canada',
          clientRating: '4.85 of 5 stars',
          proposalsTier: '5 to 10',
          paymentVerified: true,
        },
      ],
    };
  }

  if (lower === 'url_normalization') {
    return {
      totalPages: 1,
      countText: '1 job found',
      cards: [
        {
          id: '~022112225892746435112',
          href: '/jobs/On-Off-span-class-highlight-WordPress-span-amp-Host--Server_~022112225892746435112/?referrer_url_path=/nx/search/jobs/',
          titleHtml: 'On/Off WordPress &amp; Host Server Setup',
          postedText: 'Posted 1 hour ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$1,250.00',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months',
          descriptionHtml: 'Configure On/Off WordPress &amp; Host Server caching.',
          skills: ['WordPress', 'Linux'],
          clientLocation: 'United States',
          clientRating: '4.9 of 5 stars',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
      ],
    };
  }

  if (lower === 'budget_stage3') {
    return {
      totalPages: 1,
      countText: '2 jobs found',
      cards: [
        {
          id: '~022115332344639171',
          href: '/jobs/On-Page-SEO-Expert-Audit_~022115332344639171/',
          titleHtml: 'On-Page SEO Expert Needed — Audit + WordPress/Elementor Implementation',
          postedText: 'Posted 2 hours ago',
          jobTypeLabel: 'Fixed price',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months',
          descriptionHtml: 'Comprehensive technical SEO and WordPress implementation.',
          skills: ['WordPress', 'SEO'],
          clientLocation: 'United States',
          clientRating: '4.95 of 5 stars',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
        {
          id: '~022115332344639172',
          href: '/jobs/WordPress-Landing-Page-Cleanup_~022115332344639172/',
          titleHtml: 'WordPress Landing Page Cleanup',
          postedText: 'Posted 6 hours ago',
          jobTypeLabel: 'Fixed price',
          experienceLevel: 'Intermediate',
          durationText: 'Less than 1 month',
          descriptionHtml: 'Clean up an existing landing page layout.',
          skills: ['WordPress', 'CSS'],
          clientLocation: 'United States',
          clientRating: '4.7 of 5 stars',
          proposalsTier: '5 to 10',
          paymentVerified: true,
        },
      ],
    };
  }

  if (lower === 'missing_optional') {
    return {
      totalPages: 1,
      countText: '3 jobs found',
      cards: [
        {
          id: '~022111887415567641942',
          href: '/jobs/Website-Migration_~022111887415567641942/',
          titleHtml: 'Minimal Card Without Optional Fields',
          postedText: 'Posted 1 hour ago',
          jobTypeLabel: 'Fixed price',
          experienceLevel: '',
          descriptionHtml: 'Card with title and URL only.',
          skills: [],
        },
        {
          id: '~022111887415567641944',
          href: '/jobs/Missing-Title-Card_~022111887415567641944/',
          titleHtml: '',
          omitTitle: true,
          postedText: 'Posted 2 hours ago',
          jobTypeLabel: 'Fixed price',
          experienceLevel: 'Entry level',
          descriptionHtml: 'Card missing required title anchor.',
          skills: ['HTML'],
        },
        {
          id: '~022115332344639171',
          href: '/jobs/On-Page-SEO-Expert-Audit_~022115332344639171/',
          titleHtml: 'Complete Card After Missing Title',
          postedText: 'Posted 2 hours ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$1,500.00',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months',
          descriptionHtml: 'Complete card with all optional fields populated.',
          skills: ['WordPress', 'SEO'],
          clientLocation: 'United States',
          clientRating: '4.95 of 5 stars',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
      ],
    };
  }

  if (lower === 'boundary_cases') {
    return {
      totalPages: 1,
      countText: '5 jobs found',
      cards: [
        {
          id: '~030100000000000000001',
          href: '/jobs/Golang-or-Go-engineer_~030100000000000000001/',
          titleHtml: 'Golang or Go engineer',
          postedText: 'Posted 23 hours ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$1,200.00',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months',
          descriptionHtml: 'Build backend APIs for high-throughput telemetry.',
          skills: ['Go', 'Golang'],
          clientLocation: 'United States',
          clientRating: '4.9 of 5 stars',
          clientSpend: '10k total spent',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
        {
          id: '~022111887415567641941',
          href: '/jobs/Django-and-PostgreSQL_~022111887415567641941/',
          titleHtml: 'Django and PostgreSQL',
          postedText: 'Posted 25 hours ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$2,500.00',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months',
          descriptionHtml: 'Maintain Python web services and relational schemas.',
          skills: ['Python', 'Django', 'PostgreSQL'],
          clientLocation: 'Canada',
          clientRating: '4.8 of 5 stars',
          clientSpend: '$20K total spent',
          proposalsTier: '10 to 15',
          paymentVerified: true,
        },
        {
          id: '~022111887415567641942',
          href: '/jobs/Good-Google_~022111887415567641942/',
          titleHtml: 'Good Google',
          postedText: 'Posted 1 week ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$1,000.00',
          experienceLevel: 'Intermediate',
          durationText: 'Less than 1 month',
          descriptionHtml: 'Analytics tag auditing and Search Console reporting.',
          skills: ['SEO', 'Analytics'],
          clientLocation: 'United Kingdom',
          clientRating: '4.7 of 5 stars',
          clientSpend: '$15K total spent',
          proposalsTier: '20 to 50',
          paymentVerified: true,
        },
        {
          id: '~022111887415567641944',
          href: '/jobs/ASP-NET-Core_~022111887415567641944/',
          titleHtml: 'ASP.NET Core',
          postedText: 'Posted 1 month ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$900.00',
          experienceLevel: 'Entry level',
          durationText: 'Less than 1 month',
          descriptionHtml: 'Enterprise C# Web API endpoints and SQL integration.',
          skills: ['C#', '.NET'],
          clientLocation: 'Australia',
          clientRating: '4.5 of 5 stars',
          clientSpend: '$5K total spent',
          proposalsTier: '50+',
          paymentVerified: true,
        },
        {
          id: '~022111887415567642001',
          href: '/jobs/Computer-networking_~022111887415567642001/',
          titleHtml: 'Computer networking',
          postedText: 'Posted 1 week ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$1,400.00',
          experienceLevel: 'Intermediate',
          durationText: '1 to 3 months',
          descriptionHtml: 'Configure VLAN routing and firewall policies.',
          skills: ['Cisco', 'Routing'],
          clientLocation: 'United States',
          clientRating: '4.8 of 5 stars',
          clientSpend: '$12K total spent',
          proposalsTier: '20 to 50',
          paymentVerified: true,
        },
      ],
    };
  }

  // Default / WordPress / drawer / mutated_drift
  if (page === 1) {
    return {
      cards: buildBaselinePage1Cards(),
      totalPages: config.totalSearchPages,
      countText: '6 jobs found',
    };
  }
  if (page === 2) {
    return {
      cards: buildBaselinePage2Cards(),
      totalPages: config.totalSearchPages,
      countText: '6 jobs found',
    };
  }
  return {
    cards: buildPageNCard(page),
    totalPages: config.totalSearchPages,
    countText: '6 jobs found',
  };
}

export function renderSearchJobsPage(url: URL, config: MockServerConfig): string {
  const q = url.searchParams.get('q') ?? 'WordPress';
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const driftMode = resolveEffectiveDriftMode(url, config);
  const { cards, totalPages, countText } = buildCardsForSearchQuery(q, page, config);

  const cardsHtml = cards
    .map((card, idx) =>
      renderCard(card, idx, config.authState, driftMode, config.omitDomClientMetrics),
    )
    .join('\n');

  const hasNext = cards.length > 0 && page < totalPages;
  const encodedQ = encodeURIComponent(q);
  const paginationHtml =
    cards.length > 0
      ? `<div data-test="JobsPagination" class="air3-card">
    <nav data-test="UpCPagination" aria-label="Pagination">
      <ul data-test="pagination">
        <li><a data-test="prev-page" ${page <= 1 ? 'aria-disabled="true"' : `href="/nx/search/jobs/?q=${encodedQ}&page=${page - 1}"`}>Previous page</a></li>
        <li data-test="pagination-nr"><a data-test="pagination-item" href="/nx/search/jobs/?q=${encodedQ}&page=${page}" aria-current="page">${page}</a></li>
        ${
          hasNext
            ? `<li><a data-test="next-page" href="/nx/search/jobs/?q=${encodedQ}&page=${page + 1}" aria-label="Next">Next page</a></li>`
            : '<li><a data-test="next-page" aria-disabled="true" disabled aria-label="Next">Next page</a></li>'
        }
      </ul>
    </nav>
  </div>`
      : '';

  const drawerJobId = url.searchParams.get('drawer');
  const defaultDrawerJob = getJobDetailSpec(drawerJobId ?? '~022115332344639171');
  const drawerMarkup = defaultDrawerJob
    ? `<div class="air3-drawer-backdrop">${renderJobDetailsContentInner(defaultDrawerJob, {
        driftMode,
        omitDomClientMetrics: config.omitDomClientMetrics,
        asDrawer: true,
      })}</div>`
    : '';

  const preloadedDrawerHtml = drawerJobId ? drawerMarkup : '';

  const graphqlScript = config.passiveTapEnabled
    ? `<script>
  setTimeout(() => {
    fetch('/api/graphql?alias=searchJobPostings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationName: 'SearchJobPostings',
        variables: { query: new URLSearchParams(location.search).get('q') || '' }
      })
    }).catch(() => {});
  }, 50);
</script>`
    : '';

  const drawerScript = `<script>
(() => {
  const host = document.getElementById('job-drawer-host');
  const template = ${JSON.stringify(drawerMarkup)};
  document.querySelectorAll('[data-test="open-drawer-btn"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (host) {
        host.innerHTML = template;
      }
    });
  });
})();
</script>`;

  const extraHooks = driftMode === 'unmapped_auth' ? renderUnmappedAuthHooks() : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>${escapeHtml(q)} - Jobs | Upwork</title></head>
<body>
${renderSharedAuthenticatedNav(config.authState)}
<main data-test="JobsPage">
  <div data-test="Header">
    <span data-test="JobsCountQA JobsCount">${escapeHtml(countText)}</span>
  </div>
  <section data-test="JobsList">
${cardsHtml}
  </section>
${paginationHtml}
${extraHooks}
  <aside id="job-drawer-host" aria-label="Job Details Drawer">${preloadedDrawerHtml}</aside>
</main>
${graphqlScript}
${drawerScript}
</body>
</html>`;
}

export function renderFindWorkFeedPage(
  feed: 'best-matches' | 'most-recent' | 'saved-jobs',
  config: MockServerConfig,
): string {
  const feedConfigs: Record<
    'best-matches' | 'most-recent' | 'saved-jobs',
    { heading: string; cards: SearchCardSpec[] }
  > = {
    'best-matches': {
      heading: 'Best Matches',
      cards: [
        {
          id: '~033000000000000000001',
          href: '/jobs/Full-Stack-Go-TypeScript-Extension-Developer_~033000000000000000001/',
          titleHtml: 'Full-Stack Go &amp; TypeScript Extension Developer',
          postedText: 'Posted 1 hour ago',
          jobTypeLabel: 'Hourly: $90.00 - $115.00',
          experienceLevel: 'Expert',
          durationText: '3 to 6 months, 30+ hrs/week',
          descriptionHtml: 'Build a WXT MV3 extension paired with a Go backend.',
          skills: ['Go', 'TypeScript', 'PostgreSQL'],
          clientLocation: 'United States',
          clientRating: '4.95 of 5 stars',
          clientSpend: '$95K total spent',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
        {
          id: '~033000000000000000002',
          href: '/jobs/Playwright-E2E-Automation-Specialist_~033000000000000000002/',
          titleHtml: 'Playwright E2E Automation Specialist',
          postedText: 'Posted 2 hours ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$1,200.00',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months',
          descriptionHtml: 'Build deterministic Playwright E2E test suites.',
          skills: ['Playwright', 'TypeScript'],
          clientLocation: 'United States',
          clientRating: '4.9 of 5 stars',
          clientSpend: '$38K total spent',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
      ],
    },
    'most-recent': {
      heading: 'Most Recent',
      cards: [
        {
          id: '~033000000000000000003',
          href: '/jobs/Realtime-WebSocket-Gateway-Engineer_~033000000000000000003/',
          titleHtml: 'Realtime WebSocket Gateway Engineer',
          postedText: 'Posted 5 minutes ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$1,750.00',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months',
          descriptionHtml: 'Design a low-latency Go WebSocket bridge.',
          skills: ['Go', 'WebSockets'],
          clientLocation: 'Germany',
          clientRating: '4.9 of 5 stars',
          clientSpend: '$42K total spent',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
        {
          id: '~033000000000000000004',
          href: '/jobs/Postgres-17-Migration-Specialist_~033000000000000000004/',
          titleHtml: 'Postgres 17 Migration Specialist',
          postedText: 'Posted 18 minutes ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$1,500.00',
          experienceLevel: 'Expert',
          durationText: 'Less than 1 month',
          descriptionHtml: 'Upgrade production databases to Postgres 17 using Atlas.',
          skills: ['PostgreSQL', 'Docker'],
          clientLocation: 'United States',
          clientRating: '4.85 of 5 stars',
          clientSpend: '$55K total spent',
          proposalsTier: 'Less than 5',
          paymentVerified: true,
        },
      ],
    },
    'saved-jobs': {
      heading: 'Saved Jobs',
      cards: [
        {
          id: '~033000000000000000005',
          href: '/jobs/Saved-MCP-Tooling-Architect_~033000000000000000005/',
          titleHtml: 'Saved MCP Tooling Architect',
          postedText: 'Posted 1 day ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$2,100.00',
          experienceLevel: 'Expert',
          durationText: '1 to 3 months',
          descriptionHtml: 'Build typed MCP servers in Go with Streamable HTTP and stdio.',
          skills: ['Go', 'MCP', 'TypeScript'],
          clientLocation: 'United States',
          clientRating: '4.95 of 5 stars',
          clientSpend: '$65K total spent',
          proposalsTier: '5 to 10',
          paymentVerified: true,
          extraCardHtml:
            '<button type="button" data-test="save-job-btn" aria-pressed="true">Saved</button>',
        },
        {
          id: '~033000000000000000006',
          href: '/jobs/Saved-Shadow-DOM-UI-Engineer_~033000000000000000006/',
          titleHtml: 'Saved Shadow DOM UI Engineer',
          postedText: 'Posted 2 days ago',
          jobTypeLabel: 'Fixed price',
          fixedBudgetText: '$1,600.00',
          experienceLevel: 'Intermediate',
          durationText: '1 to 3 months',
          descriptionHtml: 'Craft isolated Shadow DOM toolbars and Side Panel UIs.',
          skills: ['TypeScript', 'CSS'],
          clientLocation: 'United Kingdom',
          clientRating: '4.8 of 5 stars',
          clientSpend: '$29K total spent',
          proposalsTier: '5 to 10',
          paymentVerified: true,
          extraCardHtml:
            '<button type="button" data-test="save-job-btn" aria-pressed="true">Saved</button>',
        },
      ],
    },
  };

  const entry = feedConfigs[feed];
  const cardsHtml = entry.cards
    .map((c, i) =>
      renderCard(c, i, config.authState, config.driftMode, config.omitDomClientMetrics),
    )
    .join('\n');

  const graphqlScript = config.passiveTapEnabled
    ? `<script>
  setTimeout(() => {
    fetch('/api/graphql?alias=feedJobPostings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationName: 'FeedJobPostings', variables: { feed: '${feed}' } })
    }).catch(() => {});
  }, 50);
</script>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>${escapeHtml(entry.heading)} | Upwork</title></head>
<body>
${renderSharedAuthenticatedNav(config.authState)}
<main data-test="JobsPage">
  <div data-test="find-work-home">
    <h1>${escapeHtml(entry.heading)}</h1>
  </div>
  <section data-test="JobsList">
${cardsHtml}
  </section>
</main>
${graphqlScript}
</body>
</html>`;
}

export function buildGraphqlSearchResponse(query: string): Record<string, unknown> {
  return {
    data: {
      search: {
        universalSearchNuxt: {
          userJobSearchV1: {
            paging: { total: 6, count: 4 },
            results: [
              {
                id: '022115332344639171',
                ciphertext: '~022115332344639171',
                title: 'On-Page SEO Expert Needed — Audit + WordPress/Elementor Implementation',
                description:
                  'We are looking for an experienced WordPress developer to rebuild our 25-35 page HVAC site (WordPress, Elementor) with a focus on local SEO.',
                query,
                jobTile: {
                  job: {
                    ciphertext: '~022115332344639171',
                    jobType: 'FIXED',
                    hourlyBudgetMin: null,
                    hourlyBudgetMax: null,
                    fixedPriceAmount: { amount: 1500.0 },
                    connectPrice: 12,
                    connects_required: 12,
                    proposalsTier: 'Less than 5',
                    publishTime: '2026-11-19T15:52:00Z',
                  },
                },
                client: {
                  totalSpent: { amount: 120000 },
                  totalHires: 52,
                  hireRate: 85,
                  client_hire_rate: 85,
                  paymentVerificationStatus: 'VERIFIED',
                  location: { country: 'United States' },
                  totalFeedback: 4.95,
                  totalReviews: 48,
                },
              },
            ],
          },
        },
      },
    },
  };
}
