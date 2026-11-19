import { defineContentScript } from 'wxt/utils/define-content-script';
import { UpworkBuddy } from '../../src/main';

export default defineContentScript({
  matches: ['https://www.upwork.com/*'],
  runAt: 'document_idle',
  main() {
    new UpworkBuddy();
  },
});
