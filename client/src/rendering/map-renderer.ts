import { Container, Graphics, Rectangle, Text, TextStyle } from 'pixi.js';
import { TileType, GAME_DAY_SECONDS, MAP_WIDTH, MAP_HEIGHT, type MapData } from '@otra/shared';

// Tile colors for v1 placeholder rendering
const TILE_COLORS: Record<number, number> = {
  [TileType.GRASS]: 0x2d5a27,
  [TileType.DIRT_PATH]: 0x8b7355,
  [TileType.STONE_ROAD]: 0x808080,
  [TileType.WATER]: 0x2255aa,
  [TileType.WALL]: 0x554433,
  [TileType.FLOOR_WOOD]: 0x9e7c4f,
  [TileType.FLOOR_STONE]: 0x999999,
  [TileType.DOOR]: 0xcc8833,
  [TileType.TREE]: 0x1a4a12,
  [TileType.BENCH]: 0x664422,
  [TileType.FENCE]: 0x443322,
  [TileType.GRAVEL]: 0x777766,
  [TileType.HEADSTONE]: 0x666666,
  [TileType.TRAIN_TRACK]: 0x444444,
  [TileType.PLATFORM]: 0x888877,
  [TileType.BUSH_BERRY]: 0x2a6622,
  [TileType.SPRING]: 0x4488cc,
  [TileType.BUSH_DEPLETED]: 0x665533,
  [TileType.SPRING_DRY]: 0x887766,
};

export class MapRenderer {
  private container: Container;
  private groundLayer: Container;
  private obstacleLayer: Container;
  private tintOverlay: Graphics;
  private buildingRoofs = new Map<string, Container>(); // building id -> roof container
  private currentBuilding: string | null = null;
  onBuildingClick: ((buildingId: string) => void) | null = null;
  private lastTintHour = -1;

  constructor(parent: Container) {
    this.container = new Container();
    this.groundLayer = new Container();
    this.obstacleLayer = new Container();
    this.tintOverlay = new Graphics();
    this.tintOverlay.zIndex = 9999;
    this.container.addChild(this.groundLayer);
    this.container.addChild(this.obstacleLayer);
    this.container.addChild(this.tintOverlay);
    parent.addChild(this.container);
  }

  render(mapData: MapData): void {
    const ts = mapData.tileSize;

    // Index which tiles belong to which building (for roof transparency)
    const buildingTiles = new Map<string, Set<string>>(); // "x,y" -> building id
    for (const building of mapData.buildings) {
      const tileSet = new Set<string>();
      for (let by = building.tileY; by < building.tileY + building.heightTiles; by++) {
        for (let bx = building.tileX; bx < building.tileX + building.widthTiles; bx++) {
          tileSet.add(`${bx},${by}`);
        }
      }
      buildingTiles.set(building.id, tileSet);
    }

    // Render ground tiles
    for (let y = 0; y < mapData.height; y++) {
      for (let x = 0; x < mapData.width; x++) {
        const tileType = mapData.ground[y][x];
        const color = TILE_COLORS[tileType] ?? 0x2d5a27;

        const g = new Graphics();
        g.rect(x * ts, y * ts, ts, ts);
        g.fill(color);
        this.groundLayer.addChild(g);
      }
    }

    // Render obstacles — separate building walls into per-building containers
    for (let y = 0; y < mapData.height; y++) {
      for (let x = 0; x < mapData.width; x++) {
        const obs = mapData.obstacles[y][x];
        if (obs === 0) continue;

        const color = TILE_COLORS[obs] ?? 0x555555;
        const g = new Graphics();

        if (obs === TileType.TREE) {
          g.rect(x * ts + 12, y * ts + 18, 8, 14);
          g.fill(0x553311);
          g.circle(x * ts + 16, y * ts + 12, 12);
          g.fill(0x226622);
        } else if (obs === TileType.BUSH_BERRY) {
          // Berry bush: dark green bush with berry dots
          g.circle(x * ts + 16, y * ts + 16, 10);
          g.fill(0x2a6622);
          // Berry dots
          g.circle(x * ts + 12, y * ts + 12, 2);
          g.fill(0xcc2244);
          g.circle(x * ts + 20, y * ts + 14, 2);
          g.fill(0xcc2244);
          g.circle(x * ts + 15, y * ts + 20, 2);
          g.fill(0xcc2244);
        } else if (obs === TileType.BUSH_DEPLETED) {
          // Depleted bush: brown/withered
          g.circle(x * ts + 16, y * ts + 16, 9);
          g.fill(0x665533);
        } else if (obs === TileType.SPRING) {
          // Spring: blue puddle
          g.ellipse(x * ts + 16, y * ts + 16, 11, 8);
          g.fill(0x4488cc);
          // Sparkle
          g.circle(x * ts + 12, y * ts + 13, 2);
          g.fill({ color: 0xaaddff, alpha: 0.7 });
        } else if (obs === TileType.SPRING_DRY) {
          // Dry spring: muddy patch
          g.ellipse(x * ts + 16, y * ts + 16, 11, 8);
          g.fill(0x887766);
        } else if (obs === TileType.FENCE) {
          g.rect(x * ts, y * ts, ts, ts);
          g.fill(color);
        } else {
          g.rect(x * ts, y * ts, ts, ts);
          g.fill(color);
          if (obs === TileType.WALL) {
            g.rect(x * ts + 1, y * ts + 1, ts - 2, ts - 2);
            g.fill(0x665544);
          }
        }

        // Check if this obstacle tile belongs to a building
        let addedToBuilding = false;
        if (obs === TileType.WALL) {
          for (const [bId, tiles] of buildingTiles) {
            if (tiles.has(`${x},${y}`)) {
              let roofContainer = this.buildingRoofs.get(bId);
              if (!roofContainer) {
                roofContainer = new Container();
                this.buildingRoofs.set(bId, roofContainer);
                this.obstacleLayer.addChild(roofContainer);
              }
              roofContainer.addChild(g);
              addedToBuilding = true;
              break;
            }
          }
        }

        if (!addedToBuilding) {
          this.obstacleLayer.addChild(g);
        }
      }
    }

    // Add building labels — positioned outside near the door
    const labelStyle = new TextStyle({
      fontFamily: 'Courier New',
      fontSize: 9,
      fill: 0xccccaa,
      align: 'center',
      letterSpacing: 0.5,
      dropShadow: { color: 0x000000, blur: 3, distance: 0, alpha: 0.8 },
    });

    for (const building of mapData.buildings) {
      const label = new Text({ text: building.name.toUpperCase(), style: labelStyle });
      label.anchor.set(0.5, 0.5);

      // Place label outside the building, near the primary door
      const door = building.doors[0];
      if (door) {
        const doorCenterX = door.tileX * ts + ts / 2;
        const doorCenterY = door.tileY * ts + ts / 2;
        if (door.facing === 'south') {
          label.x = doorCenterX;
          label.y = doorCenterY + ts + 4;
        } else if (door.facing === 'north') {
          label.x = doorCenterX;
          label.y = doorCenterY - ts - 4;
        } else if (door.facing === 'west') {
          label.x = doorCenterX - ts - 4;
          label.y = doorCenterY;
        } else {
          label.x = doorCenterX + ts + 4;
          label.y = doorCenterY;
        }
      } else {
        // Fallback: center below building
        label.x = (building.tileX + building.widthTiles / 2) * ts;
        label.y = (building.tileY + building.heightTiles) * ts + 8;
      }

      // Make label clickable
      label.eventMode = 'static';
      label.cursor = 'pointer';
      label.hitArea = new Rectangle(
        -label.width / 2 - 10, -label.height / 2 - 6,
        label.width + 20, label.height + 12,
      );
      label.on('pointerdown', (e: { stopPropagation: () => void }) => {
        e.stopPropagation();
        this.onBuildingClick?.(building.id);
      });

      this.obstacleLayer.addChild(label);
    }
  }

  /** Set current building — makes its roof semi-transparent */
  setCurrentBuilding(buildingId: string | null): void {
    if (buildingId === this.currentBuilding) return;

    // Restore previous building roof
    if (this.currentBuilding) {
      const prev = this.buildingRoofs.get(this.currentBuilding);
      if (prev) prev.alpha = 1;
    }

    this.currentBuilding = buildingId;

    // Make current building roof transparent
    if (buildingId) {
      const current = this.buildingRoofs.get(buildingId);
      if (current) current.alpha = 0.2;
    }
  }

  /** Apply a tint overlay based on game hour for day/night cycle */
  setTimeOfDay(worldTimeSec: number): void {
    const daySeconds = worldTimeSec % GAME_DAY_SECONDS;
    const hour = daySeconds / 3600;  // fractional hour (0-24)

    // Only redraw if the hour changed meaningfully (every ~6 game minutes)
    const quantizedHour = Math.floor(hour * 10);
    if (quantizedHour === this.lastTintHour) return;
    this.lastTintHour = quantizedHour;

    // Calculate tint color and alpha based on hour
    // 6-8: dawn (warm orange fading out)
    // 8-18: day (no tint)
    // 18-20: dusk (warm orange fading in)
    // 20-6: night (dark blue)
    let color = 0x000020;  // deep night blue
    let alpha = 0;

    if (hour >= 6 && hour < 8) {
      // Dawn: transition from night to day
      const t = (hour - 6) / 2;  // 0 to 1
      color = 0x332200;  // warm dawn
      alpha = 0.3 * (1 - t);  // fades from 0.3 to 0
    } else if (hour >= 8 && hour < 18) {
      // Day: no tint
      alpha = 0;
    } else if (hour >= 18 && hour < 20) {
      // Dusk: transition from day to night
      const t = (hour - 18) / 2;  // 0 to 1
      color = 0x331100;  // warm dusk
      alpha = 0.3 * t;  // fades from 0 to 0.3
    } else {
      // Night (20-6)
      color = 0x000020;
      alpha = 0.45;
    }

    this.tintOverlay.clear();
    if (alpha > 0) {
      this.tintOverlay.rect(0, 0, MAP_WIDTH, MAP_HEIGHT);
      this.tintOverlay.fill({ color, alpha });
    }
  }
}
