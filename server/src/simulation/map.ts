import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { MapData } from '@otra/shared';
import { TILE_SIZE } from '@otra/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class TileMap {
  readonly data: MapData;
  readonly widthPx: number;
  readonly heightPx: number;
  private blocked: boolean[][];

  constructor(mapData: MapData) {
    this.data = mapData;
    this.widthPx = mapData.width * mapData.tileSize;
    this.heightPx = mapData.height * mapData.tileSize;

    // Build collision grid from obstacles layer
    this.blocked = Array.from({ length: mapData.height }, (_, y) =>
      Array.from({ length: mapData.width }, (_, x) => mapData.obstacles[y][x] !== 0)
    );
  }

  isTileBlocked(tileX: number, tileY: number): boolean {
    if (tileX < 0 || tileX >= this.data.width || tileY < 0 || tileY >= this.data.height) {
      return true; // out of bounds = blocked
    }
    return this.blocked[tileY][tileX];
  }

  isPositionBlocked(px: number, py: number, halfSize: number): boolean {
    // Check all tiles that the hitbox overlaps
    const left = Math.floor((px - halfSize) / TILE_SIZE);
    const right = Math.floor((px + halfSize - 0.01) / TILE_SIZE);
    const top = Math.floor((py - halfSize) / TILE_SIZE);
    const bottom = Math.floor((py + halfSize - 0.01) / TILE_SIZE);

    for (let ty = top; ty <= bottom; ty++) {
      for (let tx = left; tx <= right; tx++) {
        if (this.isTileBlocked(tx, ty)) return true;
      }
    }
    return false;
  }

  /** Check if there's line-of-sight between two points using raycasting */
  hasLineOfSight(x1: number, y1: number, x2: number, y2: number): boolean {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return true;

    // Step through the ray in small increments
    const steps = Math.ceil(dist / (TILE_SIZE / 2));
    const stepX = dx / steps;
    const stepY = dy / steps;

    for (let i = 1; i < steps; i++) {
      const px = x1 + stepX * i;
      const py = y1 + stepY * i;
      const tx = Math.floor(px / TILE_SIZE);
      const ty = Math.floor(py / TILE_SIZE);
      if (this.isTileBlocked(tx, ty)) return false;
    }
    return true;
  }

  /** Check if a ray passes through any wall (for sound muffling) */
  countWallsBetween(x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) return 0;

    const steps = Math.ceil(dist / (TILE_SIZE / 2));
    const stepX = dx / steps;
    const stepY = dy / steps;
    let walls = 0;
    let lastBlocked = false;

    for (let i = 1; i < steps; i++) {
      const px = x1 + stepX * i;
      const py = y1 + stepY * i;
      const tx = Math.floor(px / TILE_SIZE);
      const ty = Math.floor(py / TILE_SIZE);
      const blocked = this.isTileBlocked(tx, ty);
      if (blocked && !lastBlocked) walls++;
      lastBlocked = blocked;
    }
    return walls;
  }

  static loadFromFile(path?: string): TileMap {
    const filePath = path || join(__dirname, '..', '..', 'data', 'map.json');
    const raw = readFileSync(filePath, 'utf-8');
    const data: MapData = JSON.parse(raw);
    return new TileMap(data);
  }
}
