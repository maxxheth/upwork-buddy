/**
 * Floating action buttons for triggering various UI actions
 */

export class ButtonManager {
  private container: HTMLDivElement;
  private analyzeButton: HTMLButtonElement;
  private profileButton: HTMLButtonElement;
  private projectsButton: HTMLButtonElement;

  constructor(
    private onAnalyze: () => void,
    private onProfileConfig: () => void,
    private onViewProjects: () => void
  ) {
    this.container = this.createContainer();
    this.analyzeButton = this.createAnalyzeButton();
    this.profileButton = this.createProfileButton();
    this.projectsButton = this.createProjectsButton();

    // Add buttons to container
    this.container.appendChild(this.profileButton);
    this.container.appendChild(this.projectsButton);
    this.container.appendChild(this.analyzeButton);

    document.body.appendChild(this.container);
  }

  /**
   * Create the button container
   */
  private createContainer(): HTMLDivElement {
    const container = document.createElement('div');
    container.className = 'upwork-buddy-button-container';
    container.id = 'upwork-buddy-button-container';
    return container;
  }

  /**
   * Create the Analyze Job button
   */
  private createAnalyzeButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'upwork-buddy-trigger';
    button.id = 'upwork-buddy-trigger';
    button.innerHTML = '<span>🤖</span><span>Analyze Job</span>';

    button.addEventListener('click', () => {
      this.onAnalyze();
    });

    return button;
  }

  /**
   * Create the Profile Settings button
   */
  private createProfileButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'upwork-buddy-profile-btn';
    button.id = 'upwork-buddy-profile-btn';
    button.innerHTML = '<span>⚙️</span><span>Profile Settings</span>';

    button.addEventListener('click', () => {
      this.onProfileConfig();
    });

    return button;
  }

  /**
   * Create the View Projects button
   */
  private createProjectsButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'upwork-buddy-view-projects-btn';
    button.id = 'upwork-buddy-view-projects-btn';
    button.innerHTML = '<span>📋</span><span>View Projects</span><span class="badge">0</span>';

    button.addEventListener('click', () => {
      this.onViewProjects();
    });

    return button;
  }

  /**
   * Show the button container (when job drawer opens)
   */
  showContainer(): void {
    this.container.classList.add('visible');
  }

  /**
   * Hide the button container (when job drawer closes)
   */
  hideContainer(): void {
    this.container.classList.remove('visible');
  }

  /**
   * Show the analyze button (deprecated - container manages visibility now)
   */
  showAnalyzeButton(): void {
    this.showContainer();
  }

  /**
   * Hide the analyze button
   */
  hideAnalyzeButton(): void {
    this.analyzeButton.style.display = 'none';
  }
}
