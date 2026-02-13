export interface ShopItem {
  id: string;
  name: string;
  item_type: string;
  price: number;
  hunger_restore: number;
  thirst_restore: number;
  energy_effect: number;
  bladder_effect: number;
  durability: number;          // -1 = single use, >0 = number of uses
  description: string;
}

export interface JobDefinition {
  id: string;
  title: string;
  building_id: string;
  wage_per_shift: number;
  shift_length_hours: number;
  max_positions: number;
  description: string;
}

export interface Transaction {
  id: number;
  timestamp: string;
  from_id: string | null;
  to_id: string | null;
  amount: number;
  reason: string;
}
