export enum TileType {
  GRASS = 0,
  DIRT_PATH = 1,
  STONE_ROAD = 2,
  WATER = 3,
  WALL = 4,
  FLOOR_WOOD = 5,
  FLOOR_STONE = 6,
  DOOR = 7,
  TREE = 8,
  BENCH = 9,
  FENCE = 10,
  GRAVEL = 11,
  HEADSTONE = 12,
  TRAIN_TRACK = 13,
  PLATFORM = 14,
}

export interface BuildingDoor {
  tileX: number;
  tileY: number;
  facing: 'north' | 'south' | 'east' | 'west';
}

export interface InteractionZone {
  x: number;        // tile coords within building interior
  y: number;
  width: number;    // tiles
  height: number;   // tiles
  action: string;   // e.g. 'collect_ubi', 'buy', 'use_toilet'
}

export interface BuildingPlacement {
  id: string;
  name: string;
  type: string;                    // building category
  tileX: number;                   // exterior top-left tile
  tileY: number;
  widthTiles: number;
  heightTiles: number;
  doors: BuildingDoor[];
  interactionZones: InteractionZone[];
  interiorGround: number[][];      // interior tile grid (TileType values)
  interiorObstacles: number[][];   // interior obstacles (0 = passable)
}

export interface MapData {
  width: number;                   // tiles
  height: number;                  // tiles
  tileSize: number;                // px
  ground: number[][];              // [y][x] TileType
  obstacles: number[][];           // [y][x] 0 = passable, TileType = blocked
  buildings: BuildingPlacement[];
  spawnPoint: { x: number; y: number };  // px coords for train station exit
}
