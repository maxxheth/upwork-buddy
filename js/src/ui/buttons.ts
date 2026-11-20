/**
 * Floating action buttons for triggering various UI actions
 */

export interface ButtonManagerOptions {
  mountTarget?: HTMLElement;
  onOpenSidePanel?: () => void;
  onSaveJob?: () => void;
  alwaysShowContainer?: boolean;
}

export class ButtonManager {
  private container: HTMLDivElement;
  private analyzeButton: HTMLButtonElement;
  private saveButton: HTMLButtonElement;
  private sidePanelButton: HTMLButtonElement;
  private statusPill: HTMLSpanElement;
  private profileButton: HTMLButtonElement;
  private projectsButton: HTMLButtonElement;
  private jobHistoryButton: HTMLButtonElement;
  private agentsButton: HTMLButtonElement;
  private readonly alwaysShowContainer: boolean;

  constructor(
    private onAnalyze: () => void,
    private onProfileConfig: () => void,
    private onViewProjects: () => void,
    private onJobHistory: () => void,
    private onAgents: () => void,
    private options: ButtonManagerOptions = {},
  ) {
    this.alwaysShowContainer = Boolean(options.alwaysShowContainer);
    this.container = this.createContainer();
    this.statusPill = this.createStatusPill();
    this.analyzeButton = this.createAnalyzeButton();
    this.saveButton = this.createSaveButton();
    this.sidePanelButton = this.createSidePanelButton();
    this.profileButton = this.createProfileButton();
    this.projectsButton = this.createProjectsButton();
    this.jobHistoryButton = this.createJobHistoryButton();
    this.agentsButton = this.createAgentsButton();

    // Place primary Analyze/Save buttons first so Shadow DOM toolbar locators match deterministically
    this.container.appendChild(this.statusPill);
    this.container.appendChild(this.analyzeButton);
    this.container.appendChild(this.saveButton);
    this.container.appendChild(this.sidePanelButton);
    this.container.appendChild(this.profileButton);
    this.container.appendChild(this.jobHistoryButton);
    this.container.appendChild(this.agentsButton);
    this.container.appendChild(this.projectsButton);

    if (this.alwaysShowContainer) {
      this.container.classList.add('visible');
    }

    const mountTarget = options.mountTarget ?? document.body;
    mountTarget.appendChild(this.container);
  }

  private createContainer(): HTMLDivElement {
    const container = document.createElement('div');
    container.className = 'upwork-buddy-button-container';
    container.id = 'upwork-buddy-button-container';
    container.setAttribute('data-testid', 'upwork-buddy-toolbar');
    return container;
  }

  private createStatusPill(): HTMLSpanElement {
    const pill = document.createElement('span');
    pill.className = 'upwork-buddy-status-pill';
    pill.id = 'upwork-buddy-status-pill';
    pill.setAttribute('data-testid', 'toolbar-status-pill');
    pill.textContent = 'Offline';
    return pill;
  }

  private createAnalyzeButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'upwork-buddy-trigger';
    button.id = 'upwork-buddy-trigger';
    button.setAttribute('data-testid', 'toolbar-analyze-btn');
    button.innerHTML = '<span>🤖</span><span>Analyze Job</span>';

    button.addEventListener('click', () => {
      this.onAnalyze();
    });

    return button;
  }

  private createSaveButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'upwork-buddy-save-btn';
    button.id = 'upwork-buddy-save-btn';
    button.setAttribute('data-testid', 'toolbar-save-btn');
    button.innerHTML = '<span>💾</span><span>Save Job</span>';

    button.addEventListener('click', () => {
      if (this.options.onSaveJob) {
        this.options.onSaveJob();
      } else {
        this.onAnalyze();
      }
    });

    return button;
  }

  private createSidePanelButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'upwork-buddy-sidepanel-btn';
    button.id = 'upwork-buddy-sidepanel-btn';
    button.setAttribute('data-testid', 'toolbar-sidepanel-btn');
    button.innerHTML = '<span>🧭</span><span>Side Panel</span>';

    button.addEventListener('click', () => {
      this.options.onOpenSidePanel?.();
    });

    return button;
  }

  private createProfileButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'upwork-buddy-profile-btn';
    button.id = 'upwork-buddy-profile-btn';
    button.innerHTML = '<span>⚙️</span><span>Profile Settings</span>';

    button.addEventListener('click', () => {
      this.onProfileConfig();
    });

    return button;
  }

  private createProjectsButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'upwork-buddy-view-projects-btn';
    button.id = 'upwork-buddy-view-projects-btn';
    button.innerHTML = '<span>📋</span><span>View Projects</span><span class="badge">0</span>';

    button.addEventListener('click', () => {
      this.onViewProjects();
    });

    return button;
  }

  private createJobHistoryButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'upwork-buddy-job-history-btn';
    button.id = 'upwork-buddy-job-history-btn';
    button.innerHTML = '<span>📋</span><span>Job History</span>';

    button.addEventListener('click', () => {
      this.onJobHistory();
    });

    return button;
  }

  private createAgentsButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'upwork-buddy-job-history-btn';
    button.id = 'upwork-buddy-agents-btn';
    button.innerHTML = '<span>🧩</span><span>Agents</span>';

    button.addEventListener('click', () => {
      this.onAgents();
    });

    return button;
  }

  getContainer(): HTMLDivElement {
    return this.container;
  }

  setStatus(connected: boolean, policyMode = 'confirm_in_ui', challenge = false): void {
    if (challenge) {
      this.statusPill.textContent = 'HUMAN_ACTION_REQUIRED';
      this.statusPill.dataset.status = 'challenge';
      return;
    }
    this.statusPill.textContent = connected ? `Connected (${policyMode})` : 'Offline';
    this.statusPill.dataset.status = connected ? 'connected' : 'offline';
  }

  showContainer(): void {
    this.container.classList.add('visible');
  }

  hideContainer(): void {
    if (this.alwaysShowContainer) {
      return;
    }
    this.container.classList.remove('visible');
  }

  showAnalyzeButton(): void {
    this.showContainer();
  }

  hideAnalyzeButton(): void {
    this.analyzeButton.style.display = 'none';
  }
}
