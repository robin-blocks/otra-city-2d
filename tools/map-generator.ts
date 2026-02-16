/**
 * Procedural map generator for Otra City v2.
 * Generates a 100x100 tile map with a city core, wilderness ring, and forageable resources.
 * Output: server/data/map.json
 */
import { TileType, type MapData, type BuildingPlacement, type ForageableNode } from '@otra/shared';
import { BERRY_BUSH_MAX_USES, SPRING_MAX_USES } from '@otra/shared';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const W = 100;
const H = 100;
const TILE_SIZE = 32;

// City core offset — the original 62x62 city is centered in the 100x100 map
const CX = 19; // city offset X
const CY = 19; // city offset Y

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

  // === TRAIN TRACKS along northern edge of city ===
  fillRect(ground, CX, CY + 2, 62, 1, TileType.TRAIN_TRACK);
  fillRect(obstacles, CX, CY + 2, 62, 1, TileType.TRAIN_TRACK); // blocked

  // === MAIN ROADS ===
  // Horizontal main road (the "High Street")
  fillRect(ground, CX + 5, CY + 29, 52, 3, TileType.STONE_ROAD);
  // Vertical main road ("Station Road" — connects train station to center)
  fillRect(ground, CX + 29, CY + 3, 3, 54, TileType.STONE_ROAD);
  // Side road east
  fillRect(ground, CX + 44, CY + 15, 2, 30, TileType.STONE_ROAD);

  // Path to graveyard
  fillRect(ground, CX + 44, CY + 44, 12, 2, TileType.DIRT_PATH);

  // === Wilderness paths (connecting city to resource areas) ===
  fillRect(ground, 2, CY + 30, CX + 3, 1, TileType.DIRT_PATH);     // West
  fillRect(ground, CX + 57, CY + 30, W - CX - 57 - 2, 1, TileType.DIRT_PATH); // East
  fillRect(ground, CX + 30, 2, 1, CY, TileType.DIRT_PATH);          // North
  fillRect(ground, CX + 30, CY + 57, 1, H - CY - 57 - 2, TileType.DIRT_PATH); // South

  // === BUILDINGS ===
  const buildings: BuildingPlacement[] = [];

  // 1. Train Station — top center of city core, south of tracks
  const trainStation = { x: CX + 26, y: CY + 4, w: 10, h: 6, doorSide: 'south' as const, doorOffset: 5 };
  const tsInterior = placeBuilding(ground, obstacles, trainStation);
  fillRect(ground, CX + 26, CY + 3, 10, 1, TileType.PLATFORM);
  fillRect(obstacles, CX + 26, CY + 3, 10, 1, 0);
  buildings.push({
    id: 'train-station', name: 'Train Station', type: 'station',
    tileX: trainStation.x, tileY: trainStation.y,
    widthTiles: trainStation.w, heightTiles: trainStation.h,
    doors: [{ tileX: trainStation.x + 5, tileY: trainStation.y + trainStation.h - 1, facing: 'south' }],
    interactionZones: [{ x: 4, y: 2, width: 2, height: 1, action: 'depart' }],
    interiorGround: tsInterior.interiorGround,
    interiorObstacles: tsInterior.interiorObstacles,
  });

  // 2. Otra City Bank
  const bank = { x: CX + 20, y: CY + 24, w: 8, h: 6, doorSide: 'south' as const, doorOffset: 4 };
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

  // 3. Council Supplies
  const shop = { x: CX + 33, y: CY + 24, w: 8, h: 6, doorSide: 'south' as const, doorOffset: 3 };
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

  // 4. Council Hall
  const hall = { x: CX + 24, y: CY + 33, w: 10, h: 8, doorSide: 'north' as const, doorOffset: 5 };
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

  // 5. Council Toilet
  const toilet = { x: CX + 36, y: CY + 33, w: 5, h: 4, doorSide: 'north' as const, doorOffset: 2 };
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

  // 6. Council Mortuary
  const mortuary = { x: CX + 48, y: CY + 44, w: 7, h: 5, doorSide: 'west' as const, doorOffset: 2 };
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

  // 7. Police Station
  const policeStation = { x: CX + 8, y: CY + 33, w: 8, h: 6, doorSide: 'east' as const, doorOffset: 3 };
  const psInterior = placeBuilding(ground, obstacles, policeStation);
  buildings.push({
    id: 'police-station', name: 'Police Station', type: 'police',
    tileX: policeStation.x, tileY: policeStation.y,
    widthTiles: policeStation.w, heightTiles: policeStation.h,
    doors: [{ tileX: policeStation.x + policeStation.w - 1, tileY: policeStation.y + 3, facing: 'east' }],
    interactionZones: [{ x: 2, y: 1, width: 2, height: 1, action: 'book_suspect' }],
    interiorGround: psInterior.interiorGround,
    interiorObstacles: psInterior.interiorObstacles,
  });

  // === GRAVEYARD ===
  fillRect(ground, CX + 48, CY + 50, 12, 10, TileType.GRAVEL);
  fillRect(obstacles, CX + 48, CY + 50, 12, 10, 0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      const hx = CX + 49 + col * 3;
      const hy = CY + 51 + row * 3;
      if (hx < W && hy < H) {
        ground[hy][hx] = TileType.HEADSTONE;
      }
    }
  }

  // === CITY TREES ===
  const cityTreePositions = [
    [CX + 8, CY + 14], [CX + 10, CY + 16], [CX + 12, CY + 13], [CX + 14, CY + 17],
    [CX + 9, CY + 20], [CX + 11, CY + 22],
    [CX + 6, CY + 29], [CX + 6, CY + 31], [CX + 50, CY + 29], [CX + 50, CY + 31],
    [CX + 8, CY + 45], [CX + 12, CY + 48], [CX + 15, CY + 46], [CX + 18, CY + 50],
    [CX + 10, CY + 52],
    [CX + 5, CY + 6], [CX + 8, CY + 8], [CX + 50, CY + 6], [CX + 55, CY + 8],
    [CX + 52, CY + 14], [CX + 55, CY + 18], [CX + 53, CY + 22],
    [CX + 38, CY + 48], [CX + 15, CY + 38], [CX + 42, CY + 16],
    [CX + 20, CY + 52], [CX + 35, CY + 52],
  ];
  for (const [tx, ty] of cityTreePositions) {
    if (tx >= 0 && tx < W && ty >= 0 && ty < H && obstacles[ty][tx] === 0 && ground[ty][tx] === TileType.GRASS) {
      obstacles[ty][tx] = TileType.TREE;
    }
  }

  // === WILDERNESS TREES ===
  const wildernessTreePositions = [
    // NW
    [4, 5], [7, 8], [3, 12], [10, 4], [6, 16], [12, 9], [2, 20], [8, 22],
    // NE
    [88, 5], [92, 8], [85, 12], [95, 15], [90, 3], [87, 18], [93, 22], [96, 10],
    // SW
    [4, 85], [8, 90], [3, 78], [12, 92], [6, 95], [10, 82], [2, 88], [14, 96],
    // SE
    [88, 85], [92, 90], [85, 78], [95, 82], [90, 95], [87, 88], [93, 92], [96, 86],
    // W
    [3, 35], [5, 42], [8, 55], [4, 62], [6, 48], [10, 68],
    // E
    [92, 35], [95, 42], [88, 55], [94, 62], [90, 48], [96, 68],
    // N
    [35, 4], [42, 7], [55, 3], [62, 8], [25, 5], [72, 6],
    // S
    [35, 94], [42, 97], [55, 93], [62, 96], [25, 95], [72, 94],
  ];
  for (const [tx, ty] of wildernessTreePositions) {
    if (tx >= 0 && tx < W && ty >= 0 && ty < H && obstacles[ty][tx] === 0 && ground[ty][tx] === TileType.GRASS) {
      obstacles[ty][tx] = TileType.TREE;
    }
  }

  // === BENCHES ===
  const benchPositions = [
    [CX + 27, CY + 12], [CX + 33, CY + 12],
    [CX + 22, CY + 31], [CX + 36, CY + 31],
    [CX + 10, CY + 18], [CX + 13, CY + 21],
    [CX + 28, CY + 42], [CX + 32, CY + 42],
  ];
  for (const [bx, by] of benchPositions) {
    if (bx >= 0 && bx < W && by >= 0 && by < H && obstacles[by][bx] === 0) {
      ground[by][bx] = TileType.BENCH;
    }
  }

  // === FORAGEABLE RESOURCE NODES ===
  const forageableNodes: ForageableNode[] = [];

  // Berry bushes — 8 nodes in wilderness
  const berryPositions: Array<[number, number]> = [
    [12, 15],  // NW
    [85, 20],  // NE
    [15, 78],  // SW
    [88, 82],  // SE
    [8, 48],   // W (closer)
    [92, 50],  // E (closer)
    [40, 8],   // N
    [55, 92],  // S
  ];
  for (let i = 0; i < berryPositions.length; i++) {
    const [tx, ty] = berryPositions[i];
    if (tx < W && ty < H && obstacles[ty][tx] === 0 && ground[ty][tx] === TileType.GRASS) {
      ground[ty][tx] = TileType.BUSH_BERRY;
      forageableNodes.push({
        id: `berry_bush_${i + 1}`,
        type: 'berry_bush',
        tileX: tx, tileY: ty,
        maxUses: BERRY_BUSH_MAX_USES,
      });
    }
  }

  // Fresh springs — 10 nodes in wilderness
  const springPositions: Array<[number, number]> = [
    [18, 10],  // NW
    [80, 15],  // NE
    [10, 40],  // W mid
    [90, 45],  // E mid
    [20, 85],  // SW
    [82, 80],  // SE
    [45, 5],   // N
    [50, 95],  // S
    [6, 65],   // W far
    [94, 30],  // E far
  ];
  for (let i = 0; i < springPositions.length; i++) {
    const [tx, ty] = springPositions[i];
    if (tx < W && ty < H && obstacles[ty][tx] === 0 && ground[ty][tx] === TileType.GRASS) {
      ground[ty][tx] = TileType.SPRING;
      forageableNodes.push({
        id: `fresh_spring_${i + 1}`,
        type: 'fresh_spring',
        tileX: tx, tileY: ty,
        maxUses: SPRING_MAX_USES,
      });
    }
  }

  // === MAP BOUNDARY ===
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
    y: (trainStation.y - 0.5) * TILE_SIZE,
  };

  return {
    width: W,
    height: H,
    tileSize: TILE_SIZE,
    ground,
    obstacles,
    buildings,
    forageableNodes,
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
console.log(`  Forageable nodes: ${map.forageableNodes.length} (${map.forageableNodes.filter(n => n.type === 'berry_bush').length} berry, ${map.forageableNodes.filter(n => n.type === 'fresh_spring').length} spring)`);
console.log(`  Spawn: (${map.spawnPoint.x}, ${map.spawnPoint.y})`);
