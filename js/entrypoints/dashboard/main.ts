import '../../src/ui/dashboard.css';
import { browser } from 'wxt/browser';
import { createExtensionProxyTransport } from '../../src/api';
import { DashboardController } from '../../src/ui/dashboard-controller';

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('dashboard-root');
  if (!root) return;

  const controller = new DashboardController({
    root,
    transport: createExtensionProxyTransport(),
    surface: 'extension',
    getExtensionRuntimeStatus: async () => {
      try {
        const res = (await browser.runtime.sendMessage({
          type: 'GET_RUNTIME_STATUS',
        })) as { wsConnected?: boolean; policyMode?: string } | undefined;
        return res ?? null;
      } catch {
        return null;
      }
    },
  });

  void controller.init();
});
