import './style.css';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { mountUpworkOverlay } from '../../src/content/overlay';

export default defineContentScript({
  matches: ['https://www.upwork.com/*'],
  runAt: 'document_idle',
  cssInjectionMode: 'ui',
  async main(ctx) {
    const ui = await mountUpworkOverlay(ctx);
    ui.mount();
  },
});
