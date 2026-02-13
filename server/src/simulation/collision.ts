import { RESIDENT_HITBOX } from '@otra/shared';
import type { TileMap } from './map.js';

const HALF = RESIDENT_HITBOX / 2;

export interface MovementResult {
  x: number;
  y: number;
  blocked: boolean;
}

/**
 * Resolve movement with wall sliding.
 * Try full movement first. If blocked, try X-only, then Y-only.
 * This allows residents to slide along walls instead of stopping completely.
 */
export function resolveMovement(
  map: TileMap,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): MovementResult {
  // Try full movement
  if (!map.isPositionBlocked(toX, toY, HALF)) {
    return { x: toX, y: toY, blocked: false };
  }

  // Try X-only movement (slide horizontally)
  if (!map.isPositionBlocked(toX, fromY, HALF)) {
    return { x: toX, y: fromY, blocked: true };
  }

  // Try Y-only movement (slide vertically)
  if (!map.isPositionBlocked(fromX, toY, HALF)) {
    return { x: fromX, y: toY, blocked: true };
  }

  // Fully blocked — stay put
  return { x: fromX, y: fromY, blocked: true };
}

/**
 * Check if two residents overlap (simple circle collision).
 */
export function residentsOverlap(
  x1: number, y1: number,
  x2: number, y2: number,
  minDist: number = RESIDENT_HITBOX
): boolean {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return (dx * dx + dy * dy) < (minDist * minDist);
}
