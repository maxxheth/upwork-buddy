import { PopupController } from '../../src/ui/popup-controller';

document.addEventListener('DOMContentLoaded', () => {
  const daemonStatusEl = document.getElementById('daemon-status');
  const policyModeEl = document.getElementById('policy-mode');
  const pendingCountEl = document.getElementById('pending-approvals-count');
  const challengeBannerEl = document.getElementById('human-action-banner');
  const openSidePanelBtn = document.getElementById(
    'open-sidepanel-btn',
  ) as HTMLButtonElement | null;
  const openJobsTableBtn = document.getElementById(
    'open-jobs-table-btn',
  ) as HTMLButtonElement | null;
  const killSwitchBtn = document.getElementById('kill-switch-btn') as HTMLButtonElement | null;
  const startServerBtn = document.getElementById('start-server-btn') as HTMLButtonElement | null;
  const openOptionsBtn = document.getElementById('open-options-btn') as HTMLButtonElement | null;
  const feedbackEl = document.getElementById('popup-feedback');

  if (
    !daemonStatusEl ||
    !policyModeEl ||
    !pendingCountEl ||
    !challengeBannerEl ||
    !openSidePanelBtn ||
    !killSwitchBtn ||
    !startServerBtn ||
    !openOptionsBtn ||
    !feedbackEl
  ) {
    return;
  }

  const controller = new PopupController({
    daemonStatusEl,
    policyModeEl,
    pendingCountEl,
    challengeBannerEl,
    openSidePanelBtn,
    openJobsTableBtn,
    killSwitchBtn,
    startServerBtn,
    openOptionsBtn,
    feedbackEl,
  });

  void controller.init();
});
