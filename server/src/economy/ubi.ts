import { UBI_AMOUNT, UBI_COOLDOWN_SEC } from '@otra/shared';
import type { ResidentEntity } from '../simulation/world.js';
import { updateUbiCollection } from '../db/queries.js';

export interface UbiResult {
  success: boolean;
  message: string;
  amount?: number;
  newBalance?: number;
  cooldownRemaining?: number;
}

export function collectUbi(resident: ResidentEntity): UbiResult {
  // UBI has been discontinued — inform residents to forage instead
  if (UBI_AMOUNT === 0) {
    return {
      success: false,
      message: 'UBI has been discontinued. Forage wild berries and spring water in the wilderness to survive.',
    };
  }

  const now = Date.now();
  const elapsed = (now - resident.lastUbiCollection) / 1000;

  if (elapsed < UBI_COOLDOWN_SEC) {
    const remaining = UBI_COOLDOWN_SEC - elapsed;
    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);
    return {
      success: false,
      message: `UBI cooldown: ${hours}h ${minutes}m remaining`,
      cooldownRemaining: remaining,
    };
  }

  resident.wallet += UBI_AMOUNT;
  resident.lastUbiCollection = now;

  // Persist the UBI collection timestamp
  updateUbiCollection(resident.id);

  return {
    success: true,
    message: `Collected ${UBI_AMOUNT} QUID`,
    amount: UBI_AMOUNT,
    newBalance: resident.wallet,
  };
}
