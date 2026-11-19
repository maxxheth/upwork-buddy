import { defineConfig } from 'wxt';

export default defineConfig({
  suppressWarnings: {
    firefoxDataCollection: true,
  },
  manifest: {
    name: 'Upwork Buddy',
    version: '2.0.0',
    description:
      'Analyze Upwork job posts with AI-generated proposals and project breakdowns directly inside Upwork.',
    icons: {
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: 'Upwork Buddy',
      default_icon: {
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    permissions: ['storage'],
    host_permissions: ['https://www.upwork.com/*', 'http://127.0.0.1/*', 'http://localhost/*'],
    browser_specific_settings: {
      gecko: {
        id: 'upwork-buddy@example.com',
        strict_min_version: '109.0',
      },
    },
  },
});
