const MAX_MESSAGES = 200;

export interface ChatMessage {
  speakerId: string;
  speakerName: string;
  text: string;
  volume: string;
  toId?: string;
  toName?: string;
  timestamp?: number; // Unix ms — for relative time display
}

export class ConversationModal {
  private modal: HTMLElement;
  private body: HTMLElement;
  private btn: HTMLElement;
  private focusedAgentId = '';
  private messages: ChatMessage[] = [];
  private timeEls: Array<{ el: HTMLElement; ts: number }> = [];
  private timeUpdateInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.modal = document.getElementById('spec-conversation-modal')!;
    this.body = document.getElementById('spec-conversation-body')!;
    this.btn = document.getElementById('spec-btn-conversations')!;

    this.btn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });
    this.modal.addEventListener('click', (e) => e.stopPropagation());
    document.getElementById('spec-conversation-close')?.addEventListener('click', () => this.hide());
    this.renderEmptyState();
  }

  show(): void {
    this.modal.classList.add('visible');
    this.btn.classList.add('active');
    this.body.scrollTop = this.body.scrollHeight;
    this.startTimeUpdates();
  }

  hide(): void {
    this.modal.classList.remove('visible');
    this.btn.classList.remove('active');
    this.stopTimeUpdates();
  }

  toggle(): void {
    if (this.isVisible()) this.hide(); else this.show();
  }

  isVisible(): boolean {
    return this.modal.classList.contains('visible');
  }

  clear(): void {
    this.messages = [];
    this.timeEls = [];
    this.renderEmptyState();
  }

  setFocusedAgentId(id: string): void {
    this.focusedAgentId = id;
  }

  addMessage(msg: ChatMessage): void {
    if (this.messages.length === 0) {
      this.body.innerHTML = '';
    }
    this.messages.push(msg);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.shift();
      this.body.removeChild(this.body.firstChild!);
      this.timeEls.shift();
    }

    const isSelf = msg.speakerId === this.focusedAgentId;
    const el = document.createElement('div');
    el.className = `spec-chat-msg${isSelf ? ' self' : ''}`;

    let speakerHtml = esc(msg.speakerName);
    if (msg.toName) {
      speakerHtml += ` <span class="spec-chat-directed">\u2192 ${esc(msg.toName)}</span>`;
    }

    const volumeTag = msg.volume !== 'normal' ? ` [${msg.volume}]` : '';
    const ts = msg.timestamp ?? Date.now();
    const timeHtml = `<span class="spec-chat-time">${relativeTime(ts)}</span>`;

    el.innerHTML = `
      <div class="spec-chat-speaker">${speakerHtml}${esc(volumeTag)} ${timeHtml}</div>
      <div class="spec-chat-text">${esc(msg.text)}</div>
    `;

    const timeEl = el.querySelector('.spec-chat-time') as HTMLElement;
    this.timeEls.push({ el: timeEl, ts });

    this.body.appendChild(el);
    this.body.scrollTop = this.body.scrollHeight;
  }

  private startTimeUpdates(): void {
    if (this.timeUpdateInterval) return;
    this.timeUpdateInterval = setInterval(() => this.refreshTimes(), 30000);
  }

  private stopTimeUpdates(): void {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }
  }

  private refreshTimes(): void {
    for (const { el, ts } of this.timeEls) {
      el.textContent = relativeTime(ts);
    }
  }

  private renderEmptyState(): void {
    this.body.innerHTML = '<div class="spec-activity-item">No conversations yet.</div>';
  }
}

function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
