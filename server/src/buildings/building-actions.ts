import { TILE_SIZE, ENERGY_COST_USE_TOILET } from '@otra/shared';
import type { ResidentEntity } from '../simulation/world.js';
import type { World } from '../simulation/world.js';

export interface BuildingActionResult {
  success: boolean;
  message: string;
}

export function enterBuilding(
  resident: ResidentEntity,
  buildingId: string,
  world: World
): BuildingActionResult {
  if (resident.isSleeping) {
    return { success: false, message: 'Cannot enter building while sleeping' };
  }
  if (resident.currentBuilding) {
    return { success: false, message: 'Already inside a building' };
  }

  // Find the building in map data
  const building = world.map.data.buildings.find(b => b.id === buildingId);
  if (!building) {
    return { success: false, message: 'Building not found' };
  }

  // Check proximity to a door
  let nearDoor = false;
  for (const door of building.doors) {
    const doorX = door.tileX * TILE_SIZE + TILE_SIZE / 2;
    const doorY = door.tileY * TILE_SIZE + TILE_SIZE / 2;
    const dist = Math.sqrt((resident.x - doorX) ** 2 + (resident.y - doorY) ** 2);
    if (dist < TILE_SIZE * 2) {
      nearDoor = true;
      break;
    }
  }

  if (!nearDoor) {
    return { success: false, message: 'Too far from door' };
  }

  // Enter the building — place resident at center of building interior
  resident.currentBuilding = buildingId;
  const centerX = (building.tileX + building.widthTiles / 2) * TILE_SIZE;
  const centerY = (building.tileY + building.heightTiles / 2) * TILE_SIZE;
  resident.x = centerX;
  resident.y = centerY;
  resident.velocityX = 0;
  resident.velocityY = 0;
  resident.speed = 'stop';

  return { success: true, message: `Entered ${building.name}` };
}

export function exitBuilding(
  resident: ResidentEntity,
  world: World
): BuildingActionResult {
  if (!resident.currentBuilding) {
    return { success: false, message: 'Not inside a building' };
  }

  const building = world.map.data.buildings.find(b => b.id === resident.currentBuilding);
  if (!building || building.doors.length === 0) {
    // Fallback: just clear building state
    resident.currentBuilding = null;
    return { success: true, message: 'Exited building' };
  }

  // Place resident outside the first door
  const door = building.doors[0];
  const exitOffsets: Record<string, { dx: number; dy: number }> = {
    north: { dx: 0, dy: -1 },
    south: { dx: 0, dy: 1 },
    east: { dx: 1, dy: 0 },
    west: { dx: -1, dy: 0 },
  };
  const offset = exitOffsets[door.facing] || { dx: 0, dy: 1 };

  resident.x = (door.tileX + offset.dx) * TILE_SIZE + TILE_SIZE / 2;
  resident.y = (door.tileY + offset.dy) * TILE_SIZE + TILE_SIZE / 2;
  resident.currentBuilding = null;
  resident.velocityX = 0;
  resident.velocityY = 0;
  resident.speed = 'stop';

  return { success: true, message: `Exited ${building.name}` };
}

export function useToilet(resident: ResidentEntity): BuildingActionResult {
  if (resident.currentBuilding !== 'council-toilet') {
    return { success: false, message: 'Must be inside the Council Toilet' };
  }
  if (resident.isSleeping) {
    return { success: false, message: 'Cannot use toilet while sleeping' };
  }
  if (resident.needs.energy < ENERGY_COST_USE_TOILET) {
    return { success: false, message: 'Not enough energy' };
  }

  resident.needs.energy -= ENERGY_COST_USE_TOILET;
  resident.needs.bladder = 0;

  return { success: true, message: 'Used the toilet. Bladder emptied.' };
}
