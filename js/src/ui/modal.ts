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
        <button class="upwork-buddy-modal-btn" id="upwork-buddy-minimize" title="Minimize">−</button>
        <button class="upwork-buddy-modal-btn" id="upwork-buddy-close" title="Close">×</button>
      </div>
    `;
    return header;
  }

  private createModalBody(): HTMLDivElement {
    const body = document.createElement('div');
    body.className = 'upwork-buddy-modal-body';
    body.id = 'upwork-buddy-modal-body';
    body.innerHTML = '<div class="upwork-buddy-loading" style="text-align:center;">Choose "Profile Settings" or hit the job-specific Analyze button to begin.</div>';
    return body;
  }

  private setupEventListeners(): void {
    document.getElementById('upwork-buddy-close')?.addEventListener('click', () => {
      this.close();
    });

    document.getElementById('upwork-buddy-minimize')?.addEventListener('click', () => {
      this.toggleMinimize();
    });

    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) {
        this.close();
      }
    });
  }

  private setupDraggable(): void {
    const header = this.modal.querySelector('.upwork-buddy-modal-header') as HTMLElement;
    let isDragging = false;
    let currentX: number, currentY: number, initialX: number, initialY: number;

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
      this.modal.style.left = currentX + 'px';
      this.modal.style.top = currentY + 'px';
      this.modal.style.transform = 'none';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  open(): void {
    this.overlay.classList.add('active');
    this.resetPosition();
    this.modal.classList.remove('minimized');
    const minimizeBtn = document.getElementById('upwork-buddy-minimize');
    if (minimizeBtn) minimizeBtn.textContent = '−';
  }

  close(): void {
    this.overlay.classList.remove('active');
  }

  toggleMinimize(): void {
    this.modal.classList.toggle('minimized');
    const btn = document.getElementById('upwork-buddy-minimize');
    if (btn) {
      btn.textContent = this.modal.classList.contains('minimized') ? '+' : '−';
    }
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
