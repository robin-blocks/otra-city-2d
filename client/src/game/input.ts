import type { ActionSender } from '../network/action-sender.js';

export class InputHandler {
  private keys = new Set<string>();
  private lastDirection: number | null = null;
  private chatActive = false;

  /** Current movement direction in degrees, or null if stopped */
  currentDirection: number | null = null;
  currentSpeed: 'walk' | 'run' = 'walk';

  onChatSubmit: ((text: string) => void) | null = null;
  onHotkey: ((key: string) => void) | null = null;
  /** Whether a UI overlay is open (blocks movement but not hotkeys) */
  uiOpen = false;
  /** When true, skip all input processing (spectator has its own handlers) */
  spectatorMode = false;

  constructor(private actions: ActionSender) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // In spectator mode, skip all input processing
    if (this.spectatorMode) return;

    // Chat input handling
    if (this.chatActive) {
      if (e.key === 'Escape') {
        this.chatActive = false;
        this.hideChatInput();
      }
      return; // Let the input field handle the typing
    }

    if (e.key === 'Enter') {
      this.chatActive = true;
      this.showChatInput();
      e.preventDefault();
      return;
    }

    // Hotkeys — these fire once on keydown (not held)
    const hotkeys = ['e', 'b', 'i', 'u', 'escape'];
    if (hotkeys.includes(e.key.toLowerCase()) || e.key === 'Escape') {
      this.onHotkey?.(e.key.toLowerCase());
      if (this.uiOpen) return; // Don't add to movement keys while UI open
    }

    if (this.uiOpen) return; // Block movement while UI is open

    this.keys.add(e.key.toLowerCase());
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  /** Process input each frame and send actions */
  process(): void {
    if (this.chatActive || this.uiOpen) return;

    let dx = 0;
    let dy = 0;

    if (this.keys.has('w') || this.keys.has('arrowup')) dy -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dy += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx += 1;

    if (dx !== 0 || dy !== 0) {
      // Convert to direction in degrees
      const direction = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
      this.currentDirection = direction;
      this.currentSpeed = 'walk';

      // Only send if direction changed significantly
      if (this.lastDirection === null || Math.abs(direction - this.lastDirection) > 5) {
        this.actions.move(direction, 'walk');
        this.lastDirection = direction;
      }
    } else {
      this.currentDirection = null;
      if (this.lastDirection !== null) {
        this.actions.stop();
        this.lastDirection = null;
      }
    }
  }

  private showChatInput(): void {
    const container = document.getElementById('chat-input-container')!;
    const input = document.getElementById('chat-input') as HTMLInputElement;
    container.style.display = 'block';
    input.value = '';
    input.focus();

    const handleSubmit = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        const text = input.value.trim();
        if (text) {
          this.onChatSubmit?.(text);
        }
        this.chatActive = false;
        this.hideChatInput();
        input.removeEventListener('keydown', handleSubmit);
      } else if (e.key === 'Escape') {
        this.chatActive = false;
        this.hideChatInput();
        input.removeEventListener('keydown', handleSubmit);
      }
    };

    input.addEventListener('keydown', handleSubmit);
  }

  private hideChatInput(): void {
    const container = document.getElementById('chat-input-container')!;
    container.style.display = 'none';
  }

  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }
}
