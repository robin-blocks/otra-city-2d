/**
 * Procedural map generator for Otra City v1.
 * Generates a 62x62 tile map with roads, buildings, and decorations.
 * Output: server/data/map.json
 */
import { TileType, type MapData, type BuildingPlacement } from '@otra/shared';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const W = 62;
const H = 62;
const TILE_SIZE = 32;

function createGrid(w: number, h: number, fill: number): number[][] {
  return Array.from({ length: h }, () => Array(w).fill(fill));
}

function fillRect(grid: number[][], x: number, y: number, w: number, h: number, value: number) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const ty = y + dy;
      const tx = x + dx;
      if (ty >= 0 && ty < grid.length && tx >= 0 && tx < grid[0].length) {
        grid[ty][tx] = value;
      }
    }
  }
}

function placeBuilding(
  ground: number[][],
  obstacles: number[][],
  b: { x: number; y: number; w: number; h: number; doorSide: 'north' | 'south' | 'east' | 'west'; doorOffset: number }
): { interiorGround: number[][]; interiorObstacles: number[][] } {
  // Place walls around the perimeter
  fillRect(obstacles, b.x, b.y, b.w, b.h, TileType.WALL);
  // Place floor inside (1 tile inset)
  fillRect(ground, b.x + 1, b.y + 1, b.w - 2, b.h - 2, TileType.FLOOR_WOOD);
  fillRect(obstacles, b.x + 1, b.y + 1, b.w - 2, b.h - 2, 0); // clear interior obstacles

  // Place door
  let doorX = b.x;
  let doorY = b.y;
  switch (b.doorSide) {
    case 'south': doorX = b.x + b.doorOffset; doorY = b.y + b.h - 1; break;
    case 'north': doorX = b.x + b.doorOffset; doorY = b.y; break;
    case 'east':  doorX = b.x + b.w - 1; doorY = b.y + b.doorOffset; break;
    case 'west':  doorX = b.x; doorY = b.y + b.doorOffset; break;
  }
  obstacles[doorY][doorX] = 0;
  ground[doorY][doorX] = TileType.DOOR;

  // Build interior grids (just the inside area)
  const iw = b.w - 2;
  const ih = b.h - 2;
  const interiorGround = createGrid(iw, ih, TileType.FLOOR_WOOD);
  const interiorObstacles = createGrid(iw, ih, 0);

  return { interiorGround, interiorObstacles };
}

function generateMap(): MapData {
  const ground = createGrid(W, H, TileType.GRASS);
  const obstacles = createGrid(W, H, 0);

  // === TRAIN TRACKS along northern edge (row 2) ===
  fillRect(ground, 0, 2, W, 1, TileType.TRAIN_TRACK);
  fillRect(obstacles, 0, 2, W, 1, TileType.TRAIN_TRACK); // blocked

  // === MAIN ROADS ===
  // Horizontal main road (y=30, the "High Street")
  fillRect(ground, 5, 29, W - 10, 3, TileType.STONE_ROAD);
  // Vertical main road (x=30, "Station Road" — connects train station to center)
  fillRect(ground, 29, 3, 3, H - 8, TileType.STONE_ROAD);
  // Side road east (x=45)
  fillRect(ground, 44, 15, 2, 30, TileType.STONE_ROAD);

  // Path to graveyard (bottom-right area)
  fillRect(ground, 44, 44, 12, 2, TileType.DIRT_PATH);

  // === BUILDINGS ===
  const buildings: BuildingPlacement[] = [];

  // 1. Train Station — top center, south of tracks
  const trainStation = { x: 26, y: 4, w: 10, h: 6, doorSide: 'south' as const, doorOffset: 5 };
  const tsInterior = placeBuilding(ground, obstacles, trainStation);
  // Platform area in front of station
  fillRect(ground, 26, 3, 10, 1, TileType.PLATFORM);
  fillRect(obstacles, 26, 3, 10, 1, 0); // platform is walkable
  buildings.push({
    id: 'train-station', name: 'Train Station', type: 'station',
    tileX: trainStation.x, tileY: trainStation.y,
    widthTiles: trainStation.w, heightTiles: trainStation.h,
    doors: [{ tileX: trainStation.x + 5, tileY: trainStation.y + trainStation.h - 1, facing: 'south' }],
    interactionZones: [{ x: 4, y: 2, width: 2, height: 1, action: 'depart' }],
    interiorGround: tsInterior.interiorGround,
    interiorObstacles: tsInterior.interiorObstacles,
  });

  // 2. Otra City Bank — central area, west of vertical road
  const bank = { x: 20, y: 24, w: 8, h: 6, doorSide: 'south' as const, doorOffset: 4 };
  const bankInterior = placeBuilding(ground, obstacles, bank);
  buildings.push({
    id: 'bank', name: 'Otra City Bank', type: 'bank',
    tileX: bank.x, tileY: bank.y,
    widthTiles: bank.w, heightTiles: bank.h,
    doors: [{ tileX: bank.x + 4, tileY: bank.y + bank.h - 1, facing: 'south' }],
    interactionZones: [{ x: 2, y: 1, width: 3, height: 1, action: 'collect_ubi' }],
    interiorGround: bankInterior.interiorGround,
    interiorObstacles: bankInterior.interiorObstacles,
  });

  // 3. Council Supplies — near bank, east of vertical road
  const shop = { x: 33, y: 24, w: 8, h: 6, doorSide: 'south' as const, doorOffset: 3 };
  const shopInterior = placeBuilding(ground, obstacles, shop);
  buildings.push({
    id: 'council-supplies', name: 'Council Supplies', type: 'shop',
    tileX: shop.x, tileY: shop.y,
    widthTiles: shop.w, heightTiles: shop.h,
    doors: [{ tileX: shop.x + 3, tileY: shop.y + shop.h - 1, facing: 'south' }],
    interactionZones: [{ x: 2, y: 1, width: 3, height: 1, action: 'buy' }],
    interiorGround: shopInterior.interiorGround,
    interiorObstacles: shopInterior.interiorObstacles,
  });

  // 4. Council Hall — central square, south of main road
  const hall = { x: 24, y: 33, w: 10, h: 8, doorSide: 'north' as const, doorOffset: 5 };
  const hallInterior = placeBuilding(ground, obstacles, hall);
  buildings.push({
    id: 'council-hall', name: 'Council Hall', type: 'hall',
    tileX: hall.x, tileY: hall.y,
    widthTiles: hall.w, heightTiles: hall.h,
    doors: [{ tileX: hall.x + 5, tileY: hall.y, facing: 'north' }],
    interactionZones: [
      { x: 2, y: 2, width: 2, height: 1, action: 'apply_job' },
      { x: 5, y: 2, width: 2, height: 1, action: 'write_petition' },
    ],
    interiorGround: hallInterior.interiorGround,
    interiorObstacles: hallInterior.interiorObstacles,
  });

  // 5. Council Toilet — near central area
  const toilet = { x: 36, y: 33, w: 5, h: 4, doorSide: 'north' as const, doorOffset: 2 };
  const toiletInterior = placeBuilding(ground, obstacles, toilet);
  buildings.push({
    id: 'council-toilet', name: 'Council Toilet', type: 'toilet',
    tileX: toilet.x, tileY: toilet.y,
    widthTiles: toilet.w, heightTiles: toilet.h,
    doors: [{ tileX: toilet.x + 2, tileY: toilet.y, facing: 'north' }],
    interactionZones: [{ x: 1, y: 1, width: 2, height: 1, action: 'use_toilet' }],
    interiorGround: toiletInterior.interiorGround,
    interiorObstacles: toiletInterior.interiorObstacles,
  });

  // 6. Council Mortuary — bottom-right, near graveyard
  const mortuary = { x: 48, y: 44, w: 7, h: 5, doorSide: 'west' as const, doorOffset: 2 };
  const mortuaryInterior = placeBuilding(ground, obstacles, mortuary);
  buildings.push({
    id: 'council-mortuary', name: 'Council Mortuary', type: 'mortuary',
    tileX: mortuary.x, tileY: mortuary.y,
    widthTiles: mortuary.w, heightTiles: mortuary.h,
    doors: [{ tileX: mortuary.x, tileY: mortuary.y + 2, facing: 'west' }],
    interactionZones: [{ x: 2, y: 1, width: 2, height: 1, action: 'process_body' }],
    interiorGround: mortuaryInterior.interiorGround,
    interiorObstacles: mortuaryInterior.interiorObstacles,
  });

  // === GRAVEYARD — bottom-right corner ===
  fillRect(ground, 48, 50, 12, 10, TileType.GRAVEL);
  fillRect(obstacles, 48, 50, 12, 10, 0); // walkable
  // Place some initial headstones
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const hx = 49 + col * 3;
      const hy = 51 + row * 3;
      if (hx < W && hy < H) {
        ground[hy][hx] = TileType.HEADSTONE;
      }
    }
  }

  // === TREES (scattered decoration) ===
  const treePositions = [
    // Park area (west side)
    [8, 14], [10, 16], [12, 13], [14, 17], [9, 20], [11, 22],
    // Along roads
    [6, 29], [6, 31], [50, 29], [50, 31],
    // South area
    [8, 45], [12, 48], [15, 46], [18, 50], [10, 52],
    // North edges
    [5, 6], [8, 8], [50, 6], [55, 8],
    // East area
    [52, 14], [55, 18], [53, 22],
    // Random scatter
    [38, 48], [15, 38], [42, 16], [20, 52], [35, 52],
  ];
  for (const [tx, ty] of treePositions) {
    if (tx < W && ty < H && obstacles[ty][tx] === 0 && ground[ty][tx] === TileType.GRASS) {
      obstacles[ty][tx] = TileType.TREE;
    }
  }

  // === BENCHES (places to rest) ===
  const benchPositions = [
    [27, 12], [33, 12],   // Near station
    [22, 31], [36, 31],   // Along main road
    [10, 18], [13, 21],   // Park area
    [28, 42], [32, 42],   // South of council hall
  ];
  for (const [bx, by] of benchPositions) {
    if (bx < W && by < H && obstacles[by][bx] === 0) {
      ground[by][bx] = TileType.BENCH;
      // Benches are walkable (you can sit on them)
    }
  }

  // === MAP BOUNDARY — fence around edges ===
  for (let x = 0; x < W; x++) {
    obstacles[0][x] = TileType.FENCE;
    obstacles[H - 1][x] = TileType.FENCE;
  }
  for (let y = 0; y < H; y++) {
    obstacles[y][0] = TileType.FENCE;
    obstacles[y][W - 1] = TileType.FENCE;
  }

  // Spawn point: on the platform in front of the train station
  const spawnPoint = {
    x: (trainStation.x + trainStation.w / 2) * TILE_SIZE,
    y: (trainStation.y - 0.5) * TILE_SIZE, // on the platform, row 3
  };

  return {
    width: W,
    height: H,
    tileSize: TILE_SIZE,
    ground,
    obstacles,
    buildings,
    spawnPoint,
  };
}

// Generate and save
const map = generateMap();
const outputDir = join(__dirname, '..', 'server', 'data');
mkdirSync(outputDir, { recursive: true });
const outputPath = join(outputDir, 'map.json');
writeFileSync(outputPath, JSON.stringify(map));
console.log(`Map generated: ${outputPath}`);
console.log(`  Size: ${map.width}x${map.height} tiles (${map.width * TILE_SIZE}x${map.height * TILE_SIZE} px)`);
console.log(`  Buildings: ${map.buildings.length}`);
console.log(`  Spawn: (${map.spawnPoint.x}, ${map.spawnPoint.y})`);
