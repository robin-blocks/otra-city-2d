import { QUID_SYMBOL } from '@otra/shared';
import type { ActionSender } from '../network/action-sender.js';

interface ShopItemDisplay {
  item_type: string;
  name: string;
  price: number;
  description: string;
}

const SHOP_ITEMS: ShopItemDisplay[] = [
  { item_type: 'bread', name: 'Bread', price: 3, description: '+30 hunger' },
  { item_type: 'water', name: 'Water Bottle', price: 2, description: '+25 thirst' },
  { item_type: 'full_meal', name: 'Full Meal', price: 6, description: '+60 hunger, +10 thirst' },
  { item_type: 'snack', name: 'Snack Bar', price: 1, description: '+10 hunger' },
  { item_type: 'energy_drink', name: 'Energy Drink', price: 4, description: '+15 energy, +20 thirst' },
  { item_type: 'sleeping_bag', name: 'Sleeping Bag', price: 15, description: '5 uses. 2x sleep recovery.' },
];

export class ShopUI {
  private overlay: HTMLElement;
  private itemsEl: HTMLElement;
  private walletEl: HTMLElement;
  private visible = false;
  private actions: ActionSender;
  private currentWallet = 0;

  constructor(actions: ActionSender) {
    this.actions = actions;
    this.overlay = document.getElementById('shop-overlay')!;
    this.itemsEl = document.getElementById('shop-items')!;
    this.walletEl = document.getElementById('shop-wallet')!;
    this.walletEl.title = 'Wallet: your available QUID balance for buying items.';
  }

  show(wallet: number): void {
    this.visible = true;
    this.currentWallet = wallet;
    this.overlay.style.display = 'block';
    this.render();
  }

  hide(): void {
    this.visible = false;
    this.overlay.style.display = 'none';
  }

  isVisible(): boolean {
    return this.visible;
  }

  updateWallet(wallet: number): void {
    this.currentWallet = wallet;
    if (this.visible) {
      this.render();
    }
  }

  private render(): void {
    this.walletEl.textContent = `Your balance: ${QUID_SYMBOL}${this.currentWallet}`;
    this.itemsEl.innerHTML = '';

    for (const item of SHOP_ITEMS) {
      const el = document.createElement('div');
      el.className = 'shop-item';

      const infoDiv = document.createElement('div');
      infoDiv.className = 'shop-item-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'shop-item-name';
      nameEl.textContent = item.name;

      const descEl = document.createElement('div');
      descEl.className = 'shop-item-desc';
      descEl.textContent = item.description;

      infoDiv.appendChild(nameEl);
      infoDiv.appendChild(descEl);

      const priceEl = document.createElement('span');
      priceEl.className = 'shop-item-price';
      priceEl.textContent = `${QUID_SYMBOL}${item.price}`;

      const buyBtn = document.createElement('button');
      buyBtn.className = 'shop-buy-btn';
      buyBtn.textContent = 'Buy';
      buyBtn.disabled = this.currentWallet < item.price;
      buyBtn.addEventListener('click', () => {
        this.actions.buy(item.item_type, 1);
        // Optimistically decrement wallet display
        this.currentWallet -= item.price;
        this.render();
      });

      el.appendChild(infoDiv);
      el.appendChild(priceEl);
      el.appendChild(buyBtn);
      this.itemsEl.appendChild(el);
    }
  }
}
