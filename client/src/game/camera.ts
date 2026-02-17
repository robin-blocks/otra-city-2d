import { Container } from 'pixi.js';
import { MAP_WIDTH, MAP_HEIGHT } from '@otra/shared';

export class Camera {
  private targetX = 0;
  private targetY = 0;
  private smoothing = 0.12;
  private screenWidth: number;
  private screenHeight: number;

  // Free/follow dual mode for spectators
  private mode: 'follow' | 'free' = 'follow';
  private freeX = 0;
  private freeY = 0;
  private panSpeed = 400; // px/sec — crosses 3200px map in 8s

  constructor(
    private worldContainer: Container,
    screenWidth: number,
    screenHeight: number,
  ) {
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
  }

  setScreenSize(w: number, h: number): void {
    this.screenWidth = w;
    this.screenHeight = h;
  }

  followPosition(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
    this.mode = 'follow';
  }

  /** Switch to free camera mode, preserving current position */
  startFreeMode(): void {
    if (this.mode === 'follow') {
      this.freeX = this.targetX;
      this.freeY = this.targetY;
    }
    this.mode = 'free';
  }

  /** Move the camera in free mode (dx/dy are -1..1 direction) */
  moveCamera(dx: number, dy: number, dt: number): void {
    if (this.mode !== 'free') this.startFreeMode();
    this.freeX += dx * this.panSpeed * dt;
    this.freeY += dy * this.panSpeed * dt;
    // Clamp to map bounds
    this.freeX = Math.max(0, Math.min(MAP_WIDTH, this.freeX));
    this.freeY = Math.max(0, Math.min(MAP_HEIGHT, this.freeY));
  }

  /** Update follow target position without changing mode */
  updateFollowTarget(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
  }

  /** Set camera free position directly (for drag-to-scroll) */
  setFreePosition(x: number, y: number): void {
    if (this.mode !== 'free') this.startFreeMode();
    this.freeX = Math.max(0, Math.min(MAP_WIDTH, x));
    this.freeY = Math.max(0, Math.min(MAP_HEIGHT, y));
  }

  getFreePosition(): { x: number; y: number } {
    return { x: this.freeX, y: this.freeY };
  }

  getMode(): 'follow' | 'free' {
    return this.mode;
  }

  update(dt: number): void {
    const posX = this.mode === 'follow' ? this.targetX : this.freeX;
    const posY = this.mode === 'follow' ? this.targetY : this.freeY;

    const cx = -posX + this.screenWidth / 2;
    const cy = -posY + this.screenHeight / 2;

    // Slightly snappier smoothing for free mode
    const factor = this.mode === 'free' ? 0.2 : this.smoothing;
    this.worldContainer.x += (cx - this.worldContainer.x) * factor;
    this.worldContainer.y += (cy - this.worldContainer.y) * factor;

    // Clamp to map bounds
    this.worldContainer.x = Math.min(0, Math.max(
      this.screenWidth - MAP_WIDTH, this.worldContainer.x
    ));
    this.worldContainer.y = Math.min(0, Math.max(
      this.screenHeight - MAP_HEIGHT, this.worldContainer.y
    ));
  }

  /** Snap camera without smoothing */
  snapTo(x: number, y: number): void {
    this.targetX = x;
    this.targetY = y;
    this.mode = 'follow';
    this.worldContainer.x = -x + this.screenWidth / 2;
    this.worldContainer.y = -y + this.screenHeight / 2;
  }
}
