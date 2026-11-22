import { browser } from 'wxt/browser';
import { z } from 'zod';
import { selectorsCacheItem, selectorsEtagItem } from './storage-items';

export const ExtractModeSchema = z.enum([
  'text',
  'full_text',
  'rendered_text',
  'attribute',
  'list',
  'sibling_text',
  'hourly_or_fixed_label',
  'ca_item_value',
]);
export type ExtractMode = z.infer<typeof ExtractModeSchema>;

export const FieldSelectorRuleSchema = z.object({
  selectors: z.array(z.string().min(1)).min(1),
  extract: ExtractModeSchema,
  attribute: z.string().optional(),
  transforms: z.array(z.string()).optional(),
  sibling_child_tag: z.string().optional(),
  join_with: z.string().optional(),
  label_contains: z.string().optional(),
  required: z.boolean().optional(),
  is_fragile: z.boolean().optional(),
  fragile_reason: z.string().optional(),
  auth_only: z.boolean().optional(),
  description: z.string().optional(),
});
export type FieldSelectorRule = z.infer<typeof FieldSelectorRuleSchema>;

export const ViewSelectorConfigSchema = z.object({
  container_selectors: z.array(z.string()).optional(),
  fields: z.record(z.string(), FieldSelectorRuleSchema),
});
export type ViewSelectorConfig = z.infer<typeof ViewSelectorConfigSchema>;

export const PageGuardConfigSchema = z.object({
  not_found_headings: z.array(z.string()),
  error_heading_selectors: z.array(z.string()),
  detail_signal_selectors: z.array(z.string()),
  auth_logged_in_selectors: z.array(z.string()).optional(),
  challenge_selectors: z.array(z.string()).optional(),
});
export type PageGuardConfig = z.infer<typeof PageGuardConfigSchema>;

export const AuthAndChallengeGuardsConfigSchema = z.object({
  login_url_patterns: z.array(z.string()).optional(),
  challenge_url_patterns: z.array(z.string()).optional(),
  challenge_selectors: z.array(z.string()).optional(),
  challenge_text_patterns: z.array(z.string()).optional(),
  logged_in_selectors: z.array(z.string()).optional(),
  logged_out_selectors: z.array(z.string()).optional(),
});
export type AuthAndChallengeGuardsConfig = z.infer<typeof AuthAndChallengeGuardsConfigSchema>;

export const SelectorConfigSchema = z.object({
  version: z.string(),
  site: z.string(),
  base_url: z.string(),
  page_guards: PageGuardConfigSchema,
  auth_and_challenge_guards: AuthAndChallengeGuardsConfigSchema.optional(),
  views: z.record(z.string(), ViewSelectorConfigSchema),
});
export type SelectorConfig = z.infer<typeof SelectorConfigSchema>;

const FEED_FIELDS: ViewSelectorConfig['fields'] = {
  title: {
    selectors: [
      'h3.job-tile-title a',
      "a[data-test*='job-tile-title-link']",
      "a.air3-link[href*='/jobs/']",
    ],
    extract: 'rendered_text',
    required: true,
  },
  url: {
    selectors: [
      'h3.job-tile-title a',
      "a[data-test*='job-tile-title-link']",
      "a.air3-link[href*='/jobs/']",
    ],
    extract: 'attribute',
    attribute: 'href',
    transforms: ['normalize_job_url'],
  },
  description: {
    selectors: [
      "span[data-test='job-description-text']",
      "[data-test='job-description-line-clamp'] .air3-line-clamp",
      "[data-test*='JobDescription'] p",
    ],
    extract: 'rendered_text',
  },
  hourly_rate: {
    selectors: [
      "strong[data-test='job-type']",
      "[data-test='job-type-label'] strong",
      "[data-test='job-type-label']",
    ],
    extract: 'hourly_or_fixed_label',
  },
  budget: {
    selectors: ["span[data-test='budget']", "[data-test='is-fixed-price']"],
    extract: 'full_text',
    transforms: ['strip_est_budget_prefix'],
  },
  experience_level: {
    selectors: ["span[data-test='contractor-tier']", "[data-test='experience-level'] strong"],
    extract: 'text',
  },
  duration: {
    selectors: ["span[data-test='duration']", "[data-test='duration-label']"],
    extract: 'full_text',
    transforms: ['strip_est_time_prefix'],
  },
  skills: {
    selectors: [
      "[data-test='token-container'] [data-test='attr-item']",
      'ul.air3-token-wrap a.air3-token',
      "[data-test='token'] span",
    ],
    extract: 'list',
  },
  posted: {
    selectors: [
      "span[data-test='posted-on']",
      "[data-test='job-published-date'] span",
      "[data-test='job-pubilshed-date'] span",
    ],
    extract: 'text',
  },
  payment_verified: {
    selectors: [
      "strong[data-test='payment-verification-status']",
      '.air3-badge-tagline-sm.is-verified',
      "[data-qa='payment-verified']",
      "[data-test='payment-verified']",
    ],
    extract: 'text',
    auth_only: true,
  },
  client_rating: {
    selectors: [
      "[data-test='js-feedback'] .air3-rating-background .sr-only",
      "[data-qa='client-rating']",
    ],
    extract: 'full_text',
    transforms: ['rating_out_of_5_float'],
    auth_only: true,
  },
  client_spent: {
    selectors: [
      "[data-qa='client-spend']",
      "[data-test='client-spend']",
      "[data-test='client-spendings'] [data-test='formatted-amount']",
      "[data-test='client-spendings']",
    ],
    extract: 'text',
    auth_only: true,
  },
  country: {
    selectors: ["[data-test='client-country']", "[data-qa='client-location']"],
    extract: 'text',
    auth_only: true,
  },
  proposals: {
    selectors: [
      "strong[data-test='proposals']",
      "[data-test='proposals-tier']",
      "[data-test='proposals']",
    ],
    extract: 'full_text',
    transforms: ['clean_proposals_text'],
    auth_only: true,
  },
};

export const BUNDLED_SELECTORS: SelectorConfig = {
  version: '2.0',
  site: 'upwork',
  base_url: 'https://www.upwork.com',
  page_guards: {
    not_found_headings: [
      'job not found',
      'this job is no longer available',
      'this job is private',
      'page not found',
      "we can't find the page",
      'access denied',
    ],
    error_heading_selectors: ['h1', 'h2', "[data-test='error-title']", '.air3-alert'],
    detail_signal_selectors: [
      "[data-cy='clock-timelog']",
      "[data-cy='fixed-price']",
      "[data-cy='expertise']",
      "[data-qa='client-location']",
    ],
  },
  auth_and_challenge_guards: {
    login_url_patterns: ['/ab/account-security/login', '/login', '/nx/signup'],
    challenge_url_patterns: ['/cdn-cgi/challenge-platform', 'challenges.cloudflare.com'],
    challenge_selectors: [
      '#challenge-running',
      '#challenge-form',
      '#cf-challenge-running',
      "iframe[src*='challenges.cloudflare.com']",
      "iframe[src*='recaptcha']",
      "[data-test='arkose-challenge']",
      "[data-test='captcha-challenge']",
      '#px-captcha',
      "[data-test='two-factor-auth']",
      "[data-test='two-factor-challenge']",
      "input[name='deviceAuth']",
      "input[name^='deviceAuth']",
    ],
    challenge_text_patterns: [
      'verify you are human',
      'checking your browser',
      'two-step verification',
      'enter verification code',
      'security check',
      'unusual activity',
    ],
    logged_in_selectors: [
      "[data-test='nav-user-menu']",
      '.air3-avatar',
      "[data-test='find-work-home']",
      "button[aria-label*='User menu']",
      'nav.air3-nav-freelancer',
      "[data-cy='user-menu']",
      '#nav-right .air3-dropdown',
    ],
    logged_out_selectors: [
      "a[href*='/ab/account-security/login']",
      "[data-test='login-link']",
      "form[action*='login']",
    ],
  },
  views: {
    search_listings: {
      container_selectors: ['article.job-tile', "article[data-test*='JobTile']"],
      fields: {
        title: {
          selectors: ["a[data-test*='job-tile-title-link']", 'h3.job-tile-title a'],
          extract: 'rendered_text',
          required: true,
          description: 'Anchor tag holding job title and relative URL',
        },
        url: {
          selectors: ["a[data-test*='job-tile-title-link']", 'h3.job-tile-title a'],
          extract: 'attribute',
          attribute: 'href',
          transforms: ['normalize_job_url'],
          description: 'Canonicalized job detail URL',
        },
        description: {
          selectors: [
            "[data-test*='JobDescription'] p",
            "[data-test*='JobDescription']",
            "span[data-test='job-description-text']",
          ],
          extract: 'rendered_text',
          description: 'Snippet paragraph inside job description container',
        },
        budget: {
          selectors: ["[data-test='is-fixed-price']", "span[data-test='budget']"],
          extract: 'full_text',
          transforms: ['strip_est_budget_prefix'],
          description: 'Fixed-price estimated budget',
        },
        hourly_rate: {
          selectors: [
            "[data-test='job-type-label'] strong",
            "[data-test='job-type-label']",
            "strong[data-test='job-type']",
          ],
          extract: 'hourly_or_fixed_label',
          description: 'Hourly rate or budget label text',
        },
        experience_level: {
          selectors: [
            "[data-test='experience-level'] strong",
            "[data-test='experience-level']",
            "span[data-test='contractor-tier']",
          ],
          extract: 'text',
          description: 'Experience level (Intermediate, Expert, Entry level)',
        },
        duration: {
          selectors: ["[data-test='duration-label']", "span[data-test='duration']"],
          extract: 'full_text',
          transforms: ['strip_est_time_prefix'],
          description: 'Estimated duration for hourly contracts',
        },
        skills: {
          selectors: [
            "[data-test='token'] span",
            '.air3-token span',
            "[data-test='token-container'] [data-test='attr-item']",
          ],
          extract: 'list',
          description: 'Skill tags listed on the card',
        },
        posted: {
          selectors: [
            "[data-test='job-pubilshed-date'] span",
            "[data-test='job-published-date'] span",
            "span[data-test='posted-on']",
          ],
          extract: 'text',
          is_fragile: true,
          fragile_reason: "Includes legacy UpWork typo 'pubilshed' alongside corrected 'published'",
          description: 'Posted relative timestamp',
        },
        country: {
          selectors: ["[data-qa='client-location']", "[data-test='client-country']"],
          extract: 'text',
          auth_only: true,
          description: 'Client country/location on card',
        },
        proposals: {
          selectors: [
            "[data-test='proposals-tier']",
            "[data-test='proposals']",
            "strong[data-test='proposals']",
          ],
          extract: 'full_text',
          transforms: ['clean_proposals_text'],
          auth_only: true,
          description: 'Proposal count tier on card',
        },
        client_rating: {
          selectors: [
            "[data-qa='client-rating']",
            "[data-test='client-rating']",
            "[data-test='js-feedback'] .air3-rating-background .sr-only",
          ],
          extract: 'text',
          transforms: ['first_token_float'],
          auth_only: true,
          description: 'Client rating float on card',
        },
        payment_verified: {
          selectors: [
            "strong[data-test='payment-verification-status']",
            '.air3-badge-tagline-sm.is-verified',
            "[data-qa='payment-verified']",
            "[data-test='payment-verified']",
          ],
          extract: 'text',
          auth_only: true,
          description: 'Payment verification badge text on card',
        },
        client_spent: {
          selectors: [
            "[data-qa='client-spend']",
            "[data-test='client-spend']",
            "[data-test='client-spendings'] [data-test='formatted-amount']",
            "[data-test='client-spendings']",
          ],
          extract: 'text',
          auth_only: true,
          description: 'Client spend badge on card',
        },
      },
    },
    best_matches: {
      container_selectors: [
        "div[data-test='job-tile-list'] > section.air3-card-section",
        "section[data-ev-sublocation='job_feed_tile']",
        'article.job-tile',
        "article[data-test*='JobTile']",
      ],
      fields: FEED_FIELDS,
    },
    most_recent: {
      container_selectors: [
        "div[data-test='job-tile-list'] > section.air3-card-section",
        "section[data-ev-sublocation='job_feed_tile']",
        'article.job-tile',
        "article[data-test*='JobTile']",
      ],
      fields: FEED_FIELDS,
    },
    saved_jobs: {
      container_selectors: [
        "div[data-test='job-tile-list'] > section.air3-card-section",
        "section[data-ev-sublocation='job_feed_tile']",
        'article.job-tile',
        "article[data-test*='JobTile']",
      ],
      fields: FEED_FIELDS,
    },
    job_detail: {
      container_selectors: ['.job-details-content', '.job-details-card'],
      fields: {
        title: {
          selectors: [
            '.job-details-card h4 span.flex-1',
            '.job-details-card h4',
            'h1',
            '.air3-card-section h4',
          ],
          extract: 'full_text',
          required: true,
        },
        description: {
          selectors: ["[data-test='Description'] p.multiline-text", "[data-test='Description']"],
          extract: 'rendered_text',
          transforms: ['strip_summary_prefix'],
        },
        posted: {
          selectors: ['.posted-on-line span', "[data-test='posted-on']"],
          extract: 'text',
        },
        hourly_rate: {
          selectors: ["[data-cy='clock-timelog']"],
          extract: 'sibling_text',
          sibling_child_tag: 'strong',
          join_with: ' - ',
        },
        budget: {
          selectors: ["[data-cy='fixed-price']"],
          extract: 'sibling_text',
          sibling_child_tag: 'strong',
        },
        experience_level: {
          selectors: ["[data-cy='expertise']"],
          extract: 'sibling_text',
          sibling_child_tag: 'strong',
        },
        duration: {
          selectors: [
            "li:has([data-cy^='duration']) strong",
            "li:has([data-cy='duration2']) strong",
            "li:has([data-cy='duration1']) strong",
          ],
          extract: 'full_text',
        },
        hours_per_week: {
          selectors: ["[data-cy='clock-hourly']"],
          extract: 'sibling_text',
          sibling_child_tag: 'strong',
        },
        skills: {
          selectors: [
            'section[data-v-3b2c2248] .skills-list .air3-line-clamp',
            '.skills-list .air3-line-clamp',
            "[data-test='proposals-insights-v2-skill-chip'] .air3-line-clamp",
            "[data-test='proposals-insights-v2-skills-matching'] .air3-badge-skill .air3-line-clamp",
            "[data-test='Skill'] .air3-line-clamp",
            "[data-test='Skill'] span",
            '.air3-badge-highlight .air3-line-clamp',
          ],
          extract: 'list',
          is_fragile: true,
          fragile_reason: 'Includes legacy Vue scope hash data-v-3b2c2248 fallback',
        },
        proposals: {
          selectors: [
            "[data-test='proposals-insights-v2-job-activity-section']",
            'li.ca-item',
            '.client-activity-items li.ca-item',
            "[data-test='proposals-tier']",
          ],
          extract: 'ca_item_value',
          label_contains: 'Proposals',
          transforms: ['clean_proposals_text'],
        },
        client_rating: {
          selectors: [
            '.air3-rating-background',
            "[data-qa='client-rating']",
            "[data-testid='buyer-rating'] .air3-rating-background .sr-only",
          ],
          extract: 'full_text',
          transforms: ['rating_out_of_5_float'],
        },
        client_reviews: {
          selectors: [
            "[data-testid='buyer-rating'] span.nowrap",
            "[data-qa='client-reviews']",
            "[data-test='client-reviews']",
          ],
          extract: 'text',
          auth_only: true,
        },
        country: {
          selectors: ["li[data-qa='client-location']", "[data-test='client-country']"],
          extract: 'text',
        },
        client_spent: {
          selectors: ["[data-qa='client-spend']", "[data-test='client-spend']"],
          extract: 'full_text',
          transforms: ['strip_total_suffix'],
        },
        client_hires: {
          selectors: ["[data-qa='client-hires']", "[data-test='client-hires']"],
          extract: 'text',
          transforms: ['first_token_int'],
        },
        payment_verified: {
          selectors: [
            "[data-test='about-client-container'] div:has(.payment-verified) > strong",
            '.cfe-ui-job-about-client div:has(.payment-verified) > strong',
            "[data-test='about-client-container'] .payment-verified",
            '.cfe-ui-job-about-client .payment-verified',
            "[data-qa='payment-verified']",
            "[data-test='payment-verified']",
          ],
          extract: 'text',
          auth_only: true,
        },
        client_hire_rate: {
          selectors: [
            "li[data-qa='client-job-posting-stats']",
            "[data-test='client-job-posting-stats']",
            "[data-qa='client-hire-rate']",
            "[data-test='client-hire-rate']",
          ],
          extract: 'full_text',
          auth_only: true,
        },
        connects_required: {
          selectors: [
            '.sidebar .air3-card-section .text-light-on-muted div:first-child strong',
            "[data-test='connects-to-send'] strong",
            "[data-test='connects-required'] strong",
            "[data-test='connects-required']",
          ],
          extract: 'text',
          transforms: ['first_token_int'],
          auth_only: true,
        },
        client_activity: {
          selectors: [
            "[data-test='proposals-insights-v2-job-activity-section']",
            "[data-test='proposals-insights-v2-job-activity']",
            'ul.client-activity-items li.ca-item',
            'li.ca-item',
          ],
          extract: 'list',
          auth_only: true,
        },
        screening_questions: {
          selectors: [
            '.air3-card-section ol.list-styled li',
            "[data-test='screening-questions'] li",
            "[data-test='questions'] li",
            '.job-questions li',
          ],
          extract: 'list',
          auth_only: true,
        },
        attachments: {
          selectors: [
            "[data-test='attachments'] a",
            '.attachments a',
            "[data-test='job-attachments'] a",
          ],
          extract: 'list',
          auth_only: true,
        },
        qualifications: {
          selectors: ['ul.qualification-items li', "[data-test='qualifications'] li"],
          extract: 'list',
          auth_only: true,
        },
      },
    },
    proposal_apply: {
      fields: {
        cover_letter: {
          selectors: [
            "textarea[data-test='cover-letter-textarea']",
            "textarea[aria-labelledby*='cover_letter']",
            "textarea[aria-label*='Cover Letter']",
            "[data-test='cover-letter'] textarea",
            "textarea[name='coverLetter']",
          ],
          extract: 'text',
          required: true,
          auth_only: true,
        },
        hourly_rate_input: {
          selectors: [
            "input[data-test='hourly-rate-input']",
            "input[data-test='hourly-rate']",
            "input[aria-label*='Hourly rate']",
            "#step-rate input[type='text']",
            "input[name='chargedRate']",
          ],
          extract: 'text',
          auth_only: true,
        },
        fixed_bid_input: {
          selectors: [
            "input[data-test='fixed-price-input']",
            "input[data-test='fixed-bid']",
            "input[aria-label*='Bid']",
            "input[name='amount']",
          ],
          extract: 'text',
          auth_only: true,
        },
        milestone_mode_radio: {
          selectors: [
            "input[name='milestoneMode']",
            "[data-test='milestone-mode'] input[type='radio']",
          ],
          extract: 'attribute',
          attribute: 'value',
          auth_only: true,
        },
        duration_dropdown: {
          selectors: [
            "[data-test='duration-dropdown']",
            "button[aria-labelledby*='duration']",
            "[data-cy='duration-select']",
          ],
          extract: 'text',
          auth_only: true,
        },
        rate_increase_dropdown: {
          selectors: [
            "select[data-test='rate-increase-select']",
            "[data-test='rate-increase-frequency']",
            "[data-test='rate-increase-dropdown']",
          ],
          extract: 'text',
          auth_only: true,
        },
        screening_question_containers: {
          selectors: [
            "[data-test='screening-question-item']",
            "[data-test='screening-question']",
            '.fe-proposal-job-questions .form-group',
            "[data-test='questions-section'] .air3-form-group",
          ],
          extract: 'list',
          auth_only: true,
        },
        screening_question_label: {
          selectors: ["[data-test='question-prompt']", 'label', '.label', 'p'],
          extract: 'text',
          auth_only: true,
        },
        screening_question_input: {
          selectors: ["[data-test='screening-answer-input']", 'textarea', "input[type='text']"],
          extract: 'text',
          auth_only: true,
        },
        connects_cost: {
          selectors: [
            "[data-test='required-connects-value']",
            "[data-test='connects-required-cost'] strong",
            "[data-test='connects-cost']",
            "[data-test='connects-required']",
            '.connects-summary strong',
          ],
          extract: 'text',
          transforms: ['first_token_int'],
          auth_only: true,
        },
        boost_bid_input: {
          selectors: [
            "input[data-test='boost-connects-input']",
            "input[data-test='boost-connects']",
            "input[aria-label*='Connects']",
            "input[name='boostBid']",
          ],
          extract: 'text',
          auth_only: true,
        },
        submit_button: {
          selectors: [
            "button[data-test='submit-proposal-btn']",
            "button[data-test='submit-proposal']",
            "button[data-cy='submit-proposal-btn']",
            'footer button.air3-btn-primary',
          ],
          extract: 'text',
          required: true,
          auth_only: true,
        },
      },
    },
    proposals_list: {
      container_selectors: [
        "[data-test='proposal-row']",
        "section.air3-card-section[data-test*='proposal']",
        '.proposals-list li',
      ],
      fields: {
        job_title: {
          selectors: [
            "a[data-test='proposal-job-link']",
            "a[href*='/jobs/']",
            "[data-test='proposal-job-title']",
          ],
          extract: 'text',
          required: true,
          auth_only: true,
        },
        proposal_url: {
          selectors: [
            "a[href*='/nx/proposals/']",
            "a[href*='/proposals/']",
            "a[data-test='proposal-job-link']",
          ],
          extract: 'attribute',
          attribute: 'href',
          auth_only: true,
        },
        status: {
          selectors: ["[data-test='proposal-status']", '.air3-badge'],
          extract: 'text',
          auth_only: true,
        },
        submitted_at: {
          selectors: [
            "[data-test='proposal-submitted-date']",
            "[data-test='submitted-date']",
            'time',
          ],
          extract: 'text',
          auth_only: true,
        },
        bid_amount: {
          selectors: ["[data-test='proposal-bid']", "[data-test='bid-amount']"],
          extract: 'text',
          auth_only: true,
        },
        viewed_badge: {
          selectors: ["[data-test='client-viewed']", '.viewed-by-client'],
          extract: 'text',
          auth_only: true,
        },
      },
    },
    messages_rooms: {
      container_selectors: [
        "[data-test='room-item']",
        "[data-test='story-room-item']",
        'li.room-list-item',
      ],
      fields: {
        room_link: {
          selectors: ["a[href*='/ab/messages/rooms']", 'a'],
          extract: 'attribute',
          attribute: 'href',
          required: true,
          auth_only: true,
        },
        client_name: {
          selectors: [
            "[data-test='room-client-name']",
            "[data-test='room-name']",
            '.room-title',
            'strong',
          ],
          extract: 'text',
          auth_only: true,
        },
        job_title: {
          selectors: ["[data-test='room-job-title']", "[data-test='room-subtitle']", '.room-topic'],
          extract: 'text',
          auth_only: true,
        },
        last_message: {
          selectors: [
            "[data-test='room-last-message']",
            "[data-test='last-message']",
            '.room-preview',
          ],
          extract: 'text',
          auth_only: true,
        },
        timestamp: {
          selectors: ["[data-test='room-timestamp']", 'time'],
          extract: 'text',
          auth_only: true,
        },
        unread_badge: {
          selectors: ["[data-test='unread-count']", '.air3-badge-notification'],
          extract: 'text',
          auth_only: true,
        },
      },
    },
    messages_thread: {
      container_selectors: [
        "[data-test='message-item']",
        '.story-item',
        "[data-test='chat-story']",
      ],
      fields: {
        sender: {
          selectors: ["[data-test='message-sender']", '.story-author', 'strong'],
          extract: 'text',
          auth_only: true,
        },
        timestamp: {
          selectors: ["[data-test='message-timestamp']", 'time'],
          extract: 'text',
          auth_only: true,
        },
        body: {
          selectors: ['.message-body', "[data-test='message-body']", '.story-message'],
          extract: 'rendered_text',
          required: true,
          auth_only: true,
        },
        attachments: {
          selectors: [
            "[data-test='message-attachment']",
            "a[href*='/att/']",
            "[data-test='message-attachment'] a",
          ],
          extract: 'list',
          auth_only: true,
        },
        composer_input: {
          selectors: [
            "textarea[data-test='composer-textarea']",
            "[data-test='message-composer'] textarea",
            "div[contenteditable='true'][role='textbox']",
            "textarea[aria-label*='Write a message']",
          ],
          extract: 'text',
          auth_only: true,
        },
        send_button: {
          selectors: [
            "button[data-test='composer-send-btn']",
            "button[data-test='send-message']",
            "button[aria-label*='Send']",
          ],
          extract: 'text',
          auth_only: true,
        },
      },
    },
  },
};

export type ProxyFetcher = (path: string, init?: RequestInit) => Promise<Response>;

async function readValidatedCachedSelectors(): Promise<SelectorConfig | null> {
  try {
    const cached = await selectorsCacheItem.getValue();
    if (cached) {
      const parsed = SelectorConfigSchema.safeParse(cached);
      if (parsed.success) {
        return parsed.data;
      }
    }
  } catch {
    // ignore storage read error
  }
  return null;
}

export async function getCachedSelectors(): Promise<SelectorConfig> {
  const valid = await readValidatedCachedSelectors();
  return valid ?? BUNDLED_SELECTORS;
}

export async function fetchAndCacheSelectors(
  proxyFetch: ProxyFetcher,
  forceRefresh = false,
): Promise<SelectorConfig> {
  const cachedValid = await readValidatedCachedSelectors();
  const fallback = cachedValid ?? BUNDLED_SELECTORS;
  const storedEtag = await selectorsEtagItem.getValue().catch(() => '');
  const etag = !forceRefresh && cachedValid !== null && storedEtag ? storedEtag : '';

  try {
    const headers: Record<string, string> = {};
    if (etag) {
      headers['If-None-Match'] = etag;
    }
    const response = await proxyFetch('/api/selectors?format=json', {
      method: 'GET',
      headers,
    });
    if (response.status === 304) {
      return fallback;
    }
    if (!response.ok) {
      return fallback;
    }
    const raw = (await response.json()) as unknown;
    const parsed = SelectorConfigSchema.safeParse(raw);
    if (!parsed.success) {
      return fallback;
    }
    await selectorsCacheItem.setValue(parsed.data).catch(() => undefined);
    const nextEtag = response.headers.get('etag')?.trim() ?? '';
    await selectorsEtagItem.setValue(nextEtag).catch(() => undefined);
    return parsed.data;
  } catch {
    return fallback;
  }
}

export async function loadActiveSelectors(forceRefresh = false): Promise<SelectorConfig> {
  try {
    if (typeof browser?.runtime?.sendMessage === 'function') {
      const res = (await browser.runtime.sendMessage({
        type: 'BG_SELECTORS_GET',
        forceRefresh,
      })) as { ok?: boolean; selectors?: unknown } | undefined;
      if (res?.ok && res.selectors) {
        const parsed = SelectorConfigSchema.safeParse(res.selectors);
        if (parsed.success) {
          return parsed.data;
        }
      }
    }
  } catch {
    // fallback to local storage / bundled selectors
  }
  return getCachedSelectors();
}
