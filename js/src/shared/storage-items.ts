import { storage } from 'wxt/utils/storage';
import {
  DEFAULT_API_URL,
  DEFAULT_JITTER_RATIO,
  DEFAULT_PACING_SECONDS,
  STORAGE_KEYS,
} from './schemas';

export const apiUrlItem = storage.defineItem<string>(STORAGE_KEYS.API_URL, {
  fallback: DEFAULT_API_URL,
});

export const authTokenItem = storage.defineItem<string>(STORAGE_KEYS.AUTH_TOKEN, {
  fallback: '',
});

export const pacingSecondsItem = storage.defineItem<number>(STORAGE_KEYS.PACING_SECONDS, {
  fallback: DEFAULT_PACING_SECONDS,
});

export const jitterRatioItem = storage.defineItem<number>(STORAGE_KEYS.JITTER_RATIO, {
  fallback: DEFAULT_JITTER_RATIO,
});

export const selectorsCacheItem = storage.defineItem<unknown | null>(STORAGE_KEYS.SELECTORS_CACHE, {
  fallback: null,
});

export const selectorsEtagItem = storage.defineItem<string>(STORAGE_KEYS.SELECTORS_ETAG, {
  fallback: '',
});

export const selectorBaselinesItem = storage.defineItem<Record<string, unknown>>(
  STORAGE_KEYS.SELECTOR_BASELINES,
  {
    fallback: {},
  },
);

export const unreadPollEnabledItem = storage.defineItem<boolean>(STORAGE_KEYS.UNREAD_POLL_ENABLED, {
  fallback: false,
});

export const unreadPollMinutesItem = storage.defineItem<number>(STORAGE_KEYS.UNREAD_POLL_MINUTES, {
  fallback: 15,
});
