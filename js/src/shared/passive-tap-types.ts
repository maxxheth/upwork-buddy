export const PASSIVE_TAP_EVENT = 'upwork-buddy:passive-tap';
export const PASSIVE_TAP_READY_EVENT = 'upwork-buddy:passive-tap-ready';

export interface PassiveTapPayload {
  kind: 'graphql' | 'xhr';
  url: string;
  operationName?: string;
  data: unknown;
  capturedAt: string;
}
