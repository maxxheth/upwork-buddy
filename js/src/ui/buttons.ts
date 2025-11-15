/**
 * Floating action buttons for triggering various UI actions
 */

export class ButtonManager {
  private analyzeButton: HTMLButtonElement;
  private profileButton: HTMLButtonElement;
  private projectsButton: HTMLButtonElement;

  constructor(
    private onAnalyze: () => void,
    private onProfileConfig: () => void,
    private onViewProjects: () => void
  ) {
    this.analyzeButton = this.createAnalyzeButton();
    this.profileButton = this.createProfileButton();
    this.projectsButton = this.createProjectsButton();

    document.body.appendChild(this.analyzeButton);
    document.body.appendChild(this.profileButton);
    document.body.appendChild(this.projectsButton);
  }

  /**
   * Create the Analyze Job button
   */
  private createAnalyzeButton(): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'upwork-buddy-trigger';
    button.id = 'upwork-buddy-trigger';
    button.innerHTML = '<span>🤖</span><span>Analyze Job</span>';
    button.style.display = 'none'; // Hidden by default

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
   * Show the analyze button
   */
  showAnalyzeButton(): void {
    this.analyzeButton.style.display = 'flex';
  }

  /**
   * Hide the analyze button
   */
  hideAnalyzeButton(): void {
    this.analyzeButton.style.display = 'none';
  }
}
