import { TILE_SIZE, ENERGY_COST_USE_TOILET, TOILET_USE_DURATION_MS, REFERRAL_REWARD, REFERRAL_MATURITY_MS, AGENT_SEPARATION_DIST, CITY_CONFIG, renderMessage } from '@otra/shared';
import type { ResidentEntity } from '../simulation/world.js';
import type { World } from '../simulation/world.js';
import { getShopCatalogWithStock } from '../economy/shop.js';
import { getOpenPetitions, getReferralStats } from '../db/queries.js';
import { getBuildingType } from './building-registry.js';

export interface BuildingActionResult {
  success: boolean;
  message: string;
}

function countBuildingOccupants(buildingId: string, world: World): number {
  let count = 0;
  for (const [, r] of world.residents) {
    if (!r.isDead && r.currentBuilding === buildingId) count++;
  }
  return count;
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

  // Enter the building — place resident near center, offset from other occupants
  const occupantCount = countBuildingOccupants(buildingId, world);
  resident.currentBuilding = buildingId;
  const centerX = (building.tileX + building.widthTiles / 2) * TILE_SIZE;
  const centerY = (building.tileY + building.heightTiles / 2) * TILE_SIZE;
  if (occupantCount > 0) {
    const angle = (occupantCount * 2 * Math.PI) / Math.max(occupantCount + 1, 6);
    resident.x = centerX + Math.cos(angle) * AGENT_SEPARATION_DIST;
    resident.y = centerY + Math.sin(angle) * AGENT_SEPARATION_DIST;
  } else {
    resident.x = centerX;
    resident.y = centerY;
  }
  resident.velocityX = 0;
  resident.velocityY = 0;
  resident.speed = 'stop';

  // Type-based welcome notifications
  const buildingType = getBuildingType(buildingId);

  if (buildingType === 'shop') {
    const catalog = getShopCatalogWithStock();
    const stockSummary = catalog
      .map(item => `${item.name} (${item.stock > 0 ? item.stock : 'out'})`)
      .join(', ');
    resident.pendingNotifications.push(`Shop stock: ${stockSummary}`);
  }

  if (buildingType === 'hall') {
    const petitions = getOpenPetitions();
    const petitionCount = petitions.length;
    if (petitionCount > 0) {
      resident.pendingNotifications.push(
        renderMessage(CITY_CONFIG.messages.councilHallWelcome, {
          petition_count: petitionCount,
          petition_count_verb: petitionCount === 1 ? 'is' : 'are',
          petition_plural: petitionCount !== 1 ? 's' : '',
        })
      );
    } else {
      resident.pendingNotifications.push(
        renderMessage(CITY_CONFIG.messages.councilHallWelcomeNoPetitions)
      );
    }
  }

  if (buildingType === 'info') {
    resident.pendingNotifications.push(
      renderMessage(CITY_CONFIG.messages.touristInfoWelcome, {
        passport_no: resident.passportNo,
        referral_reward: REFERRAL_REWARD,
      })
    );
    const stats = getReferralStats(resident.id, REFERRAL_MATURITY_MS);
    if (stats.claimable > 0) {
      resident.pendingNotifications.push(
        `You have ${stats.claimable} referral reward${stats.claimable !== 1 ? 's' : ''} ready to claim! Use claim_referrals to collect.`
      );
    }
    if (stats.maturing > 0) {
      resident.pendingNotifications.push(
        `You have ${stats.maturing} referral${stats.maturing !== 1 ? 's' : ''} still maturing (new residents must survive 1 day).`
      );
    }
  }

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
  if (!resident.currentBuilding || getBuildingType(resident.currentBuilding) !== 'toilet') {
    return { success: false, message: 'Must be inside a toilet facility' };
  }
  if (resident.isSleeping) {
    return { success: false, message: 'Cannot use toilet while sleeping' };
  }
  if (resident.toiletUseUntilMs !== null) {
    return { success: false, message: 'Already using toilet' };
  }
  if (resident.needs.energy < ENERGY_COST_USE_TOILET) {
    return { success: false, message: 'Not enough energy' };
  }

  const now = Date.now();
  resident.toiletUseStartedMs = now;
  resident.toiletUseUntilMs = now + TOILET_USE_DURATION_MS;
  resident.velocityX = 0;
  resident.velocityY = 0;
  resident.speed = 'stop';

  return { success: true, message: 'Using toilet...' };
}
