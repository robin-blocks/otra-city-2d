const MAX_MESSAGES = 200;

export interface ChatMessage {
  speakerId: string;
  speakerName: string;
  text: string;
  volume: string;
  toId?: string;
  toName?: string;
}

export class ConversationModal {
  private modal: HTMLElement;
  private body: HTMLElement;
  private btn: HTMLElement;
  private focusedAgentId = '';
  private messages: ChatMessage[] = [];

  constructor() {
    this.modal = document.getElementById('spec-conversation-modal')!;
    this.body = document.getElementById('spec-conversation-body')!;
    this.btn = document.getElementById('spec-btn-conversations')!;

    this.btn.addEventListener('click', () => this.toggle());
    document.getElementById('spec-conversation-close')?.addEventListener('click', () => this.hide());
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
    this.messages = [];
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
    }

    const isSelf = msg.speakerId === this.focusedAgentId;
    const el = document.createElement('div');
    el.className = `spec-chat-msg${isSelf ? ' self' : ''}`;

    let speakerHtml = esc(msg.speakerName);
    if (msg.toName) {
      speakerHtml += ` <span class="spec-chat-directed">\u2192 ${esc(msg.toName)}</span>`;
    }

    const volumeTag = msg.volume !== 'normal' ? ` [${msg.volume}]` : '';

    el.innerHTML = `
      <div class="spec-chat-speaker">${speakerHtml}${esc(volumeTag)}</div>
      <div class="spec-chat-text">${esc(msg.text)}</div>
    `;

    this.body.appendChild(el);
    this.body.scrollTop = this.body.scrollHeight;
  }

  private renderEmptyState(): void {
    this.body.innerHTML = '<div class="spec-activity-item">No conversations yet.</div>';
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
