const MAX_EVENTS = 100;

export class ActivityModal {
  private modal: HTMLElement;
  private body: HTMLElement;
  private btn: HTMLElement;
  private events: string[] = [];

  constructor() {
    this.modal = document.getElementById('spec-activity-modal')!;
    this.body = document.getElementById('spec-activity-body')!;
    this.btn = document.getElementById('spec-btn-activity')!;

    this.btn.addEventListener('click', () => this.toggle());
    document.getElementById('spec-activity-close')?.addEventListener('click', () => this.hide());
    this.renderEmptyState();
  }

  show(): void {
    this.modal.classList.add('visible');
    this.btn.classList.add('active');
    this.body.scrollTop = this.body.scrollHeight;
  }

  hide(): void {
    this.modal.classList.remove('visible');
    this.btn.classList.remove('active');
  }

  toggle(): void {
    if (this.isVisible()) this.hide(); else this.show();
  }

  isVisible(): boolean {
    return this.modal.classList.contains('visible');
  }

  clear(): void {
    this.events = [];
    this.renderEmptyState();
  }

  addEvent(text: string, gameTime?: number): void {
    if (this.events.length === 0) {
      this.body.innerHTML = '';
    }
    this.events.push(text);
    if (this.events.length > MAX_EVENTS) {
      this.events.shift();
      this.body.removeChild(this.body.firstChild!);
    }

    const item = document.createElement('div');
    item.className = 'spec-activity-item';

    let timeStr = '';
    if (gameTime !== undefined) {
      const hour = Math.floor((gameTime % 86400) / 3600);
      const min = Math.floor((gameTime % 3600) / 60);
      timeStr = `<span class="spec-activity-time">${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}</span>`;
    } else {
      const now = new Date();
      timeStr = `<span class="spec-activity-time">${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
    }

    item.innerHTML = `${timeStr}${esc(text)}`;
    this.body.appendChild(item);
    this.body.scrollTop = this.body.scrollHeight;
  }

  private renderEmptyState(): void {
    this.body.innerHTML = '<div class="spec-activity-item">No activity yet.</div>';
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
