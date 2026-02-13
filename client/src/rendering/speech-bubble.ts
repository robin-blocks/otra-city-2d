import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { AudibleMessage } from '@otra/shared';

interface Bubble {
  container: Container;
  speakerId: string;
  expiry: number;
  text: string;
}

const bubbleStyle = new TextStyle({
  fontFamily: 'Courier New',
  fontSize: 11,
  fill: 0x111111,
  wordWrap: true,
  wordWrapWidth: 180,
  align: 'center',
});

export class SpeechBubbleRenderer {
  private parent: Container;
  private bubbles: Bubble[] = [];
  private residentPositions = new Map<string, { x: number; y: number }>();
  // Track recently shown messages to avoid duplicates from server echo
  private recentMessages = new Set<string>();

  constructor(parent: Container) {
    this.parent = parent;
  }

  updateResidentPositions(positions: Map<string, { x: number; y: number }>): void {
    this.residentPositions = positions;
  }

  /** Add a local speech bubble immediately (for own speech) */
  addLocalMessage(speakerId: string, text: string, x: number, y: number): void {
    const key = `${speakerId}:${text}`;
    this.recentMessages.add(key);
    // Auto-clear from dedup set after 2 seconds
    setTimeout(() => this.recentMessages.delete(key), 2000);

    this.createBubble(speakerId, text, x, y);
  }

  addMessages(messages: AudibleMessage[]): void {
    for (const msg of messages) {
      // Deduplicate: skip if we already showed this locally
      const key = `${msg.from}:${msg.text}`;
      if (this.recentMessages.has(key)) continue;

      const pos = this.residentPositions.get(msg.from);
      if (!pos) continue;

      this.createBubble(msg.from, msg.text, pos.x, pos.y);
    }
  }

  private createBubble(speakerId: string, message: string, x: number, y: number): void {
    const container = new Container();
    const text = new Text({ text: message, style: bubbleStyle });
    text.anchor.set(0.5, 1);

    // Background
    const padding = 6;
    const bg = new Graphics();
    bg.roundRect(
      -text.width / 2 - padding,
      -text.height - padding,
      text.width + padding * 2,
      text.height + padding * 2,
      4,
    );
    bg.fill({ color: 0xffffff, alpha: 0.9 });
    bg.stroke({ width: 1, color: 0xcccccc });

    container.addChild(bg);
    container.addChild(text);
    container.x = x;
    container.y = y - 26;
    container.zIndex = 100000;

    this.parent.addChild(container);

    // Duration: 3s minimum, +50ms per char
    const duration = Math.max(3000, message.length * 50);
    this.bubbles.push({
      container,
      speakerId,
      expiry: Date.now() + duration,
      text: message,
    });
  }

  update(): void {
    const now = Date.now();
    this.bubbles = this.bubbles.filter(b => {
      if (now >= b.expiry) {
        this.parent.removeChild(b.container);
        b.container.destroy({ children: true });
        return false;
      }
      // Fade out in last 500ms
      const remaining = b.expiry - now;
      if (remaining < 500) {
        b.container.alpha = remaining / 500;
      }

      // Follow the speaker's position
      const pos = this.residentPositions.get(b.speakerId);
      if (pos) {
        b.container.x = pos.x;
        b.container.y = pos.y - 26;
      }

      return true;
    });
  }
}
