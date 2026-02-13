import { Container } from 'pixi.js';
import { MAP_WIDTH, MAP_HEIGHT } from '@otra/shared';

export class Camera {
  private targetX = 0;
  private targetY = 0;
  private smoothing = 0.12;
  private screenWidth: number;
  private screenHeight: number;

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
  }

  update(dt: number): void {
    const cx = -this.targetX + this.screenWidth / 2;
    const cy = -this.targetY + this.screenHeight / 2;

    this.worldContainer.x += (cx - this.worldContainer.x) * this.smoothing;
    this.worldContainer.y += (cy - this.worldContainer.y) * this.smoothing;

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
    this.worldContainer.x = -x + this.screenWidth / 2;
    this.worldContainer.y = -y + this.screenHeight / 2;
  }
}
