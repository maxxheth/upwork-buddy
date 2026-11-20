import { SidePanelController } from '../../src/ui/sidepanel-controller';

document.addEventListener('DOMContentLoaded', () => {
  const connectionPill = document.getElementById('sp-connection-pill');
  const policyBadge = document.getElementById('sp-policy-badge');
  const killSwitchBtn = document.getElementById('sp-kill-switch-btn') as HTMLButtonElement | null;
  const approvalsBadge = document.getElementById('sp-approvals-badge');
  const unreadBadge = document.getElementById('sp-unread-badge');
  const contentEl = document.getElementById('sidepanel-content');
  const tabButtons = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.sp-tab[role="tab"]'),
  );

  if (
    !connectionPill ||
    !policyBadge ||
    !killSwitchBtn ||
    !approvalsBadge ||
    !unreadBadge ||
    !contentEl
  ) {
    return;
  }

  const controller = new SidePanelController({
    root: document,
    connectionPill,
    policyBadge,
    killSwitchBtn,
    approvalsBadge,
    unreadBadge,
    tabButtons,
    contentEl,
  });

  void controller.init();
});
