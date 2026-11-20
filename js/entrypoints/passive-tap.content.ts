import { defineContentScript } from 'wxt/utils/define-content-script';
import { installPassiveTap } from '../src/content/passive-tap';

export default defineContentScript({
  matches: ['https://www.upwork.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    installPassiveTap(window);
  },
});
