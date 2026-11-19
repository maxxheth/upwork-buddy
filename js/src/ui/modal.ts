/**
 * Modal component for displaying analysis results and configuration
 */

export class Modal {
  private overlay: HTMLDivElement;
  private modal: HTMLDivElement;
  private modalBody: HTMLDivElement;

  constructor() {
    this.overlay = this.createOverlay();
    this.modal = this.createModalElement();
    this.modalBody = this.createModalBody();

    const header = this.createHeader();
    this.modal.appendChild(header);
    this.modal.appendChild(this.modalBody);
    this.overlay.appendChild(this.modal);

    this.setupEventListeners();
    this.setupDraggable();

    document.body.insertBefore(this.overlay, document.body.firstChild);
  }

  private createOverlay(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.className = 'upwork-buddy-modal-overlay';
    overlay.id = 'upwork-buddy-modal-overlay';
    return overlay;
  }

  private createModalElement(): HTMLDivElement {
    const modal = document.createElement('div');
    modal.className = 'upwork-buddy-modal';
    modal.id = 'upwork-buddy-modal';
    return modal;
  }

  private createHeader(): HTMLDivElement {
    const header = document.createElement('div');
    header.className = 'upwork-buddy-modal-header';
    header.innerHTML = `
      <div class="upwork-buddy-modal-title">
        <span>🤖</span>
        <span>AI Proposal Assistant</span>
      </div>
      <div class="upwork-buddy-modal-controls">
        <button type="button" class="upwork-buddy-modal-btn" id="upwork-buddy-close" title="Close">×</button>
      </div>
    `;
    return header;
  }

  private createModalBody(): HTMLDivElement {
    const body = document.createElement('div');
    body.className = 'upwork-buddy-modal-body';
    body.id = 'upwork-buddy-modal-body';
    body.innerHTML =
      '<div class="upwork-buddy-loading" style="text-align:center;">Choose "Profile Settings" or hit the job-specific Analyze button to begin.</div>';
    return body;
  }

  private setupEventListeners(): void {
    // Close button handler (scoped to this.modal so it works before DOM insertion and in Shadow DOM)
    const closeBtn = this.modal.querySelector<HTMLButtonElement>('#upwork-buddy-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        console.log('🚪 Modal close button clicked');
        this.close();
      });
    }

    // Click outside to close
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        console.log('🚪 Clicked outside modal, closing');
        this.close();
      }
    });
  }

  private setupDraggable(): void {
    const header = this.modal.querySelector<HTMLElement>('.upwork-buddy-modal-header');
    if (!header) return;
    let isDragging = false;
    let currentX = 0;
    let currentY = 0;
    let initialX = 0;
    let initialY = 0;

    header.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.upwork-buddy-modal-btn')) return;
      isDragging = true;
      initialX = e.clientX - (this.modal.offsetLeft || 0);
      initialY = e.clientY - (this.modal.offsetTop || 0);
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      e.preventDefault();
      currentX = e.clientX - initialX;
      currentY = e.clientY - initialY;
      this.modal.style.position = 'fixed';
      this.modal.style.left = `${currentX}px`;
      this.modal.style.top = `${currentY}px`;
      this.modal.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  open(): void {
    console.log('📂 Opening modal');
    this.overlay.classList.add('active');
    this.resetPosition();
  }

  close(): void {
    console.log('🚪 Closing modal');
    this.overlay.classList.remove('active');
  }

  resetPosition(): void {
    this.modal.style.position = 'relative';
    this.modal.style.left = '';
    this.modal.style.top = '';
    this.modal.style.transform = '';
  }

  setContent(html: string): void {
    this.modalBody.innerHTML = html;
  }

  getBody(): HTMLDivElement {
    return this.modalBody;
  }
}
