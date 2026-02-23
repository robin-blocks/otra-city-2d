/**
 * Building registry — type-based lookups for building configs.
 * All building behavior is driven by building *type*, not ID.
 */

import { CITY_CONFIG, type BuildingConfig, type BuildingType } from '@otra/shared';

const byId = new Map<string, BuildingConfig>();
const byType = new Map<BuildingType, BuildingConfig[]>();

// Index buildings on first access
function ensureIndexed(): void {
  if (byId.size > 0) return;
  for (const b of CITY_CONFIG.buildings) {
    byId.set(b.id, b);
    const list = byType.get(b.type) ?? [];
    list.push(b);
    byType.set(b.type, list);
  }
}

/** Get building config by its map ID */
export function getBuildingConfig(id: string): BuildingConfig | undefined {
  ensureIndexed();
  return byId.get(id);
}

/** Get the building type for a given building ID */
export function getBuildingType(id: string): BuildingType | undefined {
  ensureIndexed();
  return byId.get(id)?.type;
}

/** Find all buildings of a given type */
export function getBuildingsByType(type: BuildingType): BuildingConfig[] {
  ensureIndexed();
  return byType.get(type) ?? [];
}

/** Find the first building of a given type (most cities have one per type) */
export function getBuildingByType(type: BuildingType): BuildingConfig | undefined {
  ensureIndexed();
  return byType.get(type)?.[0];
}

/** Check if a building ID is of a specific type */
export function isBuildingType(id: string, type: BuildingType): boolean {
  ensureIndexed();
  return byId.get(id)?.type === type;
}
