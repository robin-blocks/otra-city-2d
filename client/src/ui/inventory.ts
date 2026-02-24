import type { InventoryItem } from '@otra/shared';
import { QUID_SYMBOL } from '@otra/shared';
import type { ActionSender } from '../network/action-sender.js';

// Item display names and consume actions
const ITEM_INFO: Record<string, { name: string; action: 'eat' | 'drink' | null }> = {
  bread: { name: 'Bread', action: 'eat' },
  water: { name: 'Water Bottle', action: 'drink' },
  full_meal: { name: 'Full Meal', action: 'eat' },
  snack: { name: 'Snack Bar', action: 'eat' },
  energy_drink: { name: 'Energy Drink', action: 'drink' },
  sleeping_bag: { name: 'Sleeping Bag', action: null },
};

export class InventoryUI {
  private overlay: HTMLElement;
  private listEl: HTMLElement;
  private walletEl: HTMLElement;
  private visible = false;
  private actions: ActionSender;

  constructor(actions: ActionSender) {
    this.actions = actions;
    this.overlay = document.getElementById('inventory-overlay')!;
    this.listEl = document.getElementById('inv-list')!;
    this.walletEl = document.getElementById('inv-wallet')!;
    this.walletEl.title = 'Wallet: your available QUID balance.';
  }

  toggle(inventory: InventoryItem[], wallet: number): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show(inventory, wallet);
    }
  }

  show(inventory: InventoryItem[], wallet: number): void {
    this.visible = true;
    this.overlay.style.display = 'block';
    this.refresh(inventory, wallet);
  }

  hide(): void {
    this.visible = false;
    this.overlay.style.display = 'none';
  }

  isVisible(): boolean {
    return this.visible;
  }

  refresh(inventory: InventoryItem[], wallet: number): void {
    this.walletEl.textContent = `${QUID_SYMBOL}${wallet}`;

    this.listEl.innerHTML = '';
    if (inventory.length === 0) {
      this.listEl.innerHTML = '<div class="inv-empty">No items</div>';
      return;
    }

    for (const item of inventory) {
      const info = ITEM_INFO[item.type] || { name: item.type, action: null };
      const el = document.createElement('div');
      el.className = 'inv-item';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'inv-item-name';
      nameSpan.textContent = info.name;

      const qtySpan = document.createElement('span');
      qtySpan.className = 'inv-item-qty';
      qtySpan.textContent = `x${item.quantity}`;

      el.appendChild(nameSpan);
      el.appendChild(qtySpan);

      if (info.action) {
        const useSpan = document.createElement('span');
        useSpan.className = 'inv-item-use';
        useSpan.textContent = info.action === 'eat' ? '[eat]' : '[drink]';
        el.appendChild(useSpan);

        el.addEventListener('click', () => {
          if (info.action === 'eat') {
            this.actions.eat(item.id);
          } else if (info.action === 'drink') {
            this.actions.drink(item.id);
          }
        });
      }

      this.listEl.appendChild(el);
    }
  }
}
