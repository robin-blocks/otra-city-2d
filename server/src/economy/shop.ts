import type { ShopItem } from '@otra/shared';
import type { ResidentEntity } from '../simulation/world.js';
import { addInventoryItem } from '../db/queries.js';
import { v4 as uuid } from 'uuid';

export const SHOP_CATALOG: ShopItem[] = [
  {
    id: 'bread',
    name: 'Bread',
    item_type: 'bread',
    price: 3,
    hunger_restore: 30,
    thirst_restore: 0,
    energy_effect: 0,
    bladder_effect: 0,
    durability: -1,
    description: 'A fresh loaf. Restores 30 hunger.',
  },
  {
    id: 'water',
    name: 'Water Bottle',
    item_type: 'water',
    price: 2,
    hunger_restore: 0,
    thirst_restore: 25,
    energy_effect: 0,
    bladder_effect: 5,
    durability: -1,
    description: 'Clean drinking water. Restores 25 thirst.',
  },
  {
    id: 'full_meal',
    name: 'Full Meal',
    item_type: 'full_meal',
    price: 6,
    hunger_restore: 60,
    thirst_restore: 10,
    energy_effect: 0,
    bladder_effect: 5,
    durability: -1,
    description: 'A hearty meal. Restores 60 hunger, 10 thirst.',
  },
  {
    id: 'snack',
    name: 'Snack Bar',
    item_type: 'snack',
    price: 1,
    hunger_restore: 10,
    thirst_restore: 0,
    energy_effect: 0,
    bladder_effect: 0,
    durability: -1,
    description: 'A quick snack. Restores 10 hunger.',
  },
  {
    id: 'energy_drink',
    name: 'Energy Drink',
    item_type: 'energy_drink',
    price: 4,
    hunger_restore: 0,
    thirst_restore: 20,
    energy_effect: 15,
    bladder_effect: 10,
    durability: -1,
    description: 'A caffeinated beverage. Restores 15 energy, 20 thirst.',
  },
  {
    id: 'sleeping_bag',
    name: 'Sleeping Bag',
    item_type: 'sleeping_bag',
    price: 15,
    hunger_restore: 0,
    thirst_restore: 0,
    energy_effect: 0,
    bladder_effect: 0,
    durability: 5,
    description: 'Sleep better. 5 uses. Doubles energy recovery rate while sleeping.',
  },
];

export function getShopItem(itemType: string): ShopItem | undefined {
  return SHOP_CATALOG.find(i => i.item_type === itemType);
}

export interface BuyResult {
  success: boolean;
  message: string;
  item?: { id: string; type: string; quantity: number };
}

export function buyItem(
  resident: ResidentEntity,
  itemType: string,
  quantity: number
): BuyResult {
  if (quantity < 1 || quantity > 10) {
    return { success: false, message: 'Invalid quantity (1-10)' };
  }

  const shopItem = getShopItem(itemType);
  if (!shopItem) {
    return { success: false, message: 'Item not found in shop' };
  }

  const totalCost = shopItem.price * quantity;
  if (resident.wallet < totalCost) {
    return { success: false, message: `Not enough QUID (need ${totalCost}, have ${resident.wallet})` };
  }

  // Deduct cost
  resident.wallet -= totalCost;

  // Add to in-memory inventory
  const existingItem = resident.inventory.find(
    i => i.type === itemType && shopItem.durability === -1
  );

  let itemId: string;
  if (existingItem && shopItem.durability === -1) {
    existingItem.quantity += quantity;
    itemId = existingItem.id;
  } else {
    itemId = uuid();
    resident.inventory.push({
      id: itemId,
      type: itemType,
      quantity,
    });
  }

  // Also persist to DB
  addInventoryItem(resident.id, itemType, quantity, shopItem.durability);

  return {
    success: true,
    message: `Bought ${quantity}x ${shopItem.name} for ${totalCost} QUID`,
    item: { id: itemId, type: itemType, quantity },
  };
}
