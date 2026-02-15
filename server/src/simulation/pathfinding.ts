import { TILE_SIZE } from '@otra/shared';
import type { TileMap } from './map.js';

/**
 * A* pathfinding on the tile grid.
 *
 * Returns an array of pixel-coordinate waypoints from (fromPx, fromPy) to
 * (toPx, toPy), or null if no path exists. The first waypoint is the next
 * tile to walk toward (not the current position). The last waypoint is the
 * exact target coordinates.
 *
 * 4-directional movement only (no diagonals) because the wall-sliding
 * collision system doesn't handle diagonal passage through single-tile gaps.
 */

interface Node {
  tx: number;
  ty: number;
  g: number;
  h: number;
  f: number;
  parent: Node | null;
}

// ---- Min-heap for A* open list ----

class MinHeap {
  private data: Node[] = [];

  get size(): number { return this.data.length; }

  push(node: Node): void {
    this.data.push(node);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): Node | undefined {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0 && last) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].f >= this.data[parent].f) break;
      [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.data[left].f < this.data[smallest].f) smallest = left;
      if (right < n && this.data[right].f < this.data[smallest].f) smallest = right;
      if (smallest === i) break;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}

// ---- A* implementation ----

const DIRS = [
  { dx: 1, dy: 0 },   // right
  { dx: -1, dy: 0 },  // left
  { dx: 0, dy: 1 },   // down
  { dx: 0, dy: -1 },  // up
];

export function findPath(
  map: TileMap,
  fromPx: number,
  fromPy: number,
  toPx: number,
  toPy: number,
): Array<{ x: number; y: number }> | null {
  const startTx = Math.floor(fromPx / TILE_SIZE);
  const startTy = Math.floor(fromPy / TILE_SIZE);
  const goalTx = Math.floor(toPx / TILE_SIZE);
  const goalTy = Math.floor(toPy / TILE_SIZE);

  // If start or goal is blocked, try to find a nearby unblocked tile
  if (map.isTileBlocked(goalTx, goalTy)) {
    // Try the 4 adjacent tiles
    let found = false;
    for (const dir of DIRS) {
      const nx = goalTx + dir.dx;
      const ny = goalTy + dir.dy;
      if (!map.isTileBlocked(nx, ny)) {
        // Redirect goal to adjacent tile, keep exact target as final waypoint
        found = true;
        break;
      }
    }
    if (!found) return null; // Goal is completely surrounded
  }

  // Same tile — just return the target point
  if (startTx === goalTx && startTy === goalTy) {
    return [{ x: toPx, y: toPy }];
  }

  const mapWidth = map.data.width;
  const key = (tx: number, ty: number) => ty * mapWidth + tx;

  const open = new MinHeap();
  const closed = new Set<number>();
  const gScores = new Map<number, number>();

  const h = (tx: number, ty: number) =>
    Math.abs(tx - goalTx) + Math.abs(ty - goalTy);

  const startNode: Node = {
    tx: startTx,
    ty: startTy,
    g: 0,
    h: h(startTx, startTy),
    f: h(startTx, startTy),
    parent: null,
  };
  open.push(startNode);
  gScores.set(key(startTx, startTy), 0);

  while (open.size > 0) {
    const current = open.pop()!;
    const ck = key(current.tx, current.ty);

    if (current.tx === goalTx && current.ty === goalTy) {
      // Reconstruct path
      return reconstructPath(current, toPx, toPy);
    }

    if (closed.has(ck)) continue;
    closed.add(ck);

    for (const dir of DIRS) {
      const nx = current.tx + dir.dx;
      const ny = current.ty + dir.dy;

      if (map.isTileBlocked(nx, ny)) continue;

      const nk = key(nx, ny);
      if (closed.has(nk)) continue;

      const ng = current.g + 1;
      const existing = gScores.get(nk);
      if (existing !== undefined && ng >= existing) continue;

      gScores.set(nk, ng);
      const nh = h(nx, ny);
      open.push({
        tx: nx,
        ty: ny,
        g: ng,
        h: nh,
        f: ng + nh,
        parent: current,
      });
    }
  }

  return null; // No path found
}

function reconstructPath(
  goalNode: Node,
  exactTargetX: number,
  exactTargetY: number,
): Array<{ x: number; y: number }> {
  const tiles: Array<{ tx: number; ty: number }> = [];
  let node: Node | null = goalNode;
  while (node) {
    tiles.push({ tx: node.tx, ty: node.ty });
    node = node.parent;
  }
  tiles.reverse();

  // Skip the first tile (current position) — start from next tile
  const waypoints: Array<{ x: number; y: number }> = [];
  for (let i = 1; i < tiles.length - 1; i++) {
    waypoints.push({
      x: tiles[i].tx * TILE_SIZE + TILE_SIZE / 2,
      y: tiles[i].ty * TILE_SIZE + TILE_SIZE / 2,
    });
  }

  // Final waypoint is the exact target pixel coordinates
  waypoints.push({ x: exactTargetX, y: exactTargetY });

  return waypoints;
}
