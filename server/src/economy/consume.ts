import { ENERGY_COST_EAT, ENERGY_COST_DRINK } from '@otra/shared';
import type { ResidentEntity } from '../simulation/world.js';
import { getShopItem } from './shop.js';

export interface ConsumeResult {
  success: boolean;
  message: string;
  effects?: {
    hunger_change: number;
    thirst_change: number;
    energy_change: number;
    bladder_change: number;
  };
}

export function consumeItem(
  resident: ResidentEntity,
  itemId: string,
  action: 'eat' | 'drink'
): ConsumeResult {
  if (resident.isSleeping) {
    return { success: false, message: 'Cannot consume items while sleeping' };
  }

  // Find item in inventory
  const itemIndex = resident.inventory.findIndex(i => i.id === itemId);
  if (itemIndex === -1) {
    return { success: false, message: 'Item not found in inventory' };
  }

  const inventoryItem = resident.inventory[itemIndex];
  const shopItem = getShopItem(inventoryItem.type);
  if (!shopItem) {
    return { success: false, message: 'Unknown item type' };
  }
  if (shopItem.item_kind !== 'consumable' && shopItem.item_kind !== 'resource') {
    return { success: false, message: `${shopItem.name} is not consumable` };
  }

  // Check energy cost
  const energyCost = action === 'eat' ? ENERGY_COST_EAT : ENERGY_COST_DRINK;
  if (resident.needs.energy < energyCost) {
    return { success: false, message: 'Not enough energy' };
  }

  // Apply effects
  resident.needs.energy -= energyCost;
  const hungerChange = Math.min(shopItem.hunger_restore, 100 - resident.needs.hunger);
  const thirstChange = Math.min(shopItem.thirst_restore, 100 - resident.needs.thirst);
  const energyChange = Math.min(shopItem.energy_effect, 100 - resident.needs.energy);
  const bladderChange = Math.min(shopItem.bladder_effect, 100 - resident.needs.bladder);

  resident.needs.hunger = Math.min(100, resident.needs.hunger + shopItem.hunger_restore);
  resident.needs.thirst = Math.min(100, resident.needs.thirst + shopItem.thirst_restore);
  resident.needs.energy = Math.min(100, resident.needs.energy + shopItem.energy_effect);
  resident.needs.bladder = Math.min(100, resident.needs.bladder + shopItem.bladder_effect);

  // Remove/decrement item
  if (inventoryItem.quantity > 1) {
    inventoryItem.quantity -= 1;
  } else {
    resident.inventory.splice(itemIndex, 1);
  }

  return {
    success: true,
    message: `Consumed ${shopItem.name}`,
    effects: {
      hunger_change: hungerChange,
      thirst_change: thirstChange,
      energy_change: energyChange,
      bladder_change: bladderChange,
    },
  };
}
