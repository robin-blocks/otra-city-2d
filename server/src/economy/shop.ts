import type { ShopItem } from '@otra/shared';
import type { ResidentEntity } from '../simulation/world.js';
import { addInventoryItem, getShopStockForItem, decrementShopStock, restockAll, getShopStock, setShopStock } from '../db/queries.js';
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

/** Max stock per item type (used for restocking) */
export const INITIAL_STOCK: Record<string, number> = {
  bread: 10,
  water: 10,
  full_meal: 5,
  snack: 15,
  energy_drink: 5,
  sleeping_bag: 2,
};

/** Initialize shop stock in DB on startup (seeds if empty) */
export function initShopStock(): void {
  const existing = getShopStock();
  if (existing.length === 0) {
    // First run — seed all items
    restockAll(INITIAL_STOCK);
    console.log('[shop] Initialized shop stock');
  }
}

// Forageable items — not sold in shops, obtained by foraging wild nodes
export const FORAGEABLE_ITEMS: ShopItem[] = [
  {
    id: 'wild_berries',
    name: 'Wild Berries',
    item_type: 'wild_berries',
    price: 0,
    hunger_restore: 12,
    thirst_restore: 5,
    energy_effect: 0,
    bladder_effect: 2,
    durability: -1,
    description: 'Foraged wild berries. Restores 12 hunger, 5 thirst.',
  },
  {
    id: 'spring_water',
    name: 'Spring Water',
    item_type: 'spring_water',
    price: 0,
    hunger_restore: 3,
    thirst_restore: 8,
    energy_effect: 0,
    bladder_effect: 3,
    durability: -1,
    description: 'Fresh spring water. Restores 8 thirst, 3 hunger.',
  },
];

export function getShopItem(itemType: string): ShopItem | undefined {
  return SHOP_CATALOG.find(i => i.item_type === itemType)
    || FORAGEABLE_ITEMS.find(i => i.item_type === itemType);
}

/** Restock all items to their initial stock levels. Returns list of restocked item names. */
export function restockShop(): string[] {
  restockAll(INITIAL_STOCK);
  const restocked: string[] = [];
  for (const item of SHOP_CATALOG) {
    restocked.push(item.name);
  }
  console.log('[shop] Restocked all items');
  return restocked;
}

/** Get current stock for a specific item type */
export function getStockForItem(itemType: string): number {
  return getShopStockForItem(itemType);
}

/** Get catalog items with current stock counts */
export function getShopCatalogWithStock(): Array<ShopItem & { stock: number }> {
  return SHOP_CATALOG.map(item => ({
    ...item,
    stock: getShopStockForItem(item.item_type),
  }));
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

  // Check stock
  const currentStock = getShopStockForItem(itemType);
  if (currentStock < quantity) {
    if (currentStock === 0) {
      return { success: false, message: `${shopItem.name} is out of stock` };
    }
    return { success: false, message: `Not enough stock (${currentStock} remaining, requested ${quantity})` };
  }

  const totalCost = shopItem.price * quantity;
  if (resident.wallet < totalCost) {
    return { success: false, message: `Not enough QUID (need ${totalCost}, have ${resident.wallet})` };
  }

  // Deduct stock
  if (!decrementShopStock(itemType, quantity)) {
    return { success: false, message: `${shopItem.name} is out of stock` };
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
