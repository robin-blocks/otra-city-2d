import { getFrameworkStyle } from './framework-colors.js';
import { QUID_SYMBOL } from '@otra/shared';

export interface FocusedAgentData {
  name: string;
  framework: string | null;
  needs: { hunger: number; thirst: number; energy: number; bladder: number; social: number; health: number };
  wallet: number;
  inventory: Array<{ type: string; quantity: number }>;
  status: string;
  current_building: string | null;
}

export interface AgentListEntry {
  id: string;
  name: string;
  framework: string | null;
  condition: string;
  is_dead: boolean;
}

export class SpectatorSidebar {
  private container: HTMLElement;
  onAgentClick: ((agentId: string) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
  }

  updateFocusedAgent(data: FocusedAgentData): void {
    const fwStyle = getFrameworkStyle(data.framework);
    const fwBadge = fwStyle
      ? `<span class="spec-focused-fw" style="background:${esc(fwStyle.cssColor)}">${esc(fwStyle.label)}</span>`
      : '';

    let statusText = data.status;
    if (data.current_building) statusText = `In ${data.current_building}`;
    if (data.status === 'dead') statusText = 'Deceased';

    const needBars = [
      { label: 'HGR', key: 'hunger', color: this.gradientColor(data.needs.hunger) },
      { label: 'THR', key: 'thirst', color: this.thirstColor(data.needs.thirst) },
      { label: 'NRG', key: 'energy', color: this.gradientColor(data.needs.energy) },
      { label: 'BDR', key: 'bladder', color: this.gradientColor(data.needs.bladder, true) },
      { label: 'SOC', key: 'social', color: this.socialColor(data.needs.social) },
      { label: 'HP', key: 'health', color: this.gradientColor(data.needs.health) },
    ];

    const needsHtml = needBars.map(n => {
      const val = (data.needs as Record<string, number>)[n.key];
      return `<div class="spec-need">
        <span class="spec-need-label">${n.label}</span>
        <span class="spec-need-bg"><span class="spec-need-fill" style="width:${val}%;background:${n.color}"></span></span>
        <span class="spec-need-val">${val.toFixed(0)}</span>
      </div>`;
    }).join('');

    let invHtml: string;
    if (data.inventory.length === 0) {
      invHtml = '<div class="spec-inv-empty">Empty</div>';
    } else {
      invHtml = data.inventory.map(i =>
        `<div class="spec-inv-item">${esc(i.type)} x${i.quantity}</div>`
      ).join('');
    }

    // Only update the focused agent section, not the agent list
    const focusedEl = this.container.querySelector('#spec-focused-section');
    const html = `
      <div class="spec-focused-header">
        <div class="spec-focused-name">${esc(data.name)}${fwBadge}</div>
        <div class="spec-focused-status">${esc(statusText)}</div>
      </div>
      <hr class="spec-divider">
      ${needsHtml}
      <hr class="spec-divider">
      <div class="spec-wallet">${QUID_SYMBOL}${data.wallet}</div>
      <hr class="spec-divider">
      <div class="spec-section-label">INVENTORY</div>
      ${invHtml}
    `;

    if (focusedEl) {
      focusedEl.innerHTML = html;
    } else {
      // First render: create both sections
      this.container.innerHTML = `
        <div id="spec-focused-section">${html}</div>
        <hr class="spec-divider">
        <div class="spec-section-label">AGENTS</div>
        <div id="spec-agent-list" class="spec-agent-list"></div>
      `;
    }
  }

  updateAgentList(agents: AgentListEntry[], focusedId: string): void {
    const listEl = this.container.querySelector('#spec-agent-list');
    if (!listEl) return;

    const sorted = [...agents].sort((a, b) => a.name.localeCompare(b.name));

    listEl.innerHTML = sorted.map(a => {
      const fwStyle = getFrameworkStyle(a.framework);
      const fwBadge = fwStyle
        ? `<span class="spec-agent-fw" style="background:${esc(fwStyle.cssColor)}">${esc(fwStyle.label)}</span>`
        : '';

      const condColor = a.is_dead ? '#c33' : a.condition === 'critical' ? '#c33' : a.condition === 'struggling' ? '#cc3' : '#3c6';
      const classes = ['spec-agent-entry'];
      if (a.id === focusedId) classes.push('focused');
      if (a.is_dead) classes.push('dead');

      return `<div class="${classes.join(' ')}" data-agent-id="${esc(a.id)}">
        <span class="spec-agent-indicator" style="background:${condColor}"></span>
        <span class="spec-agent-name">${esc(a.name)}</span>
        ${fwBadge}
      </div>`;
    }).join('');

    // Wire click handlers
    listEl.querySelectorAll('.spec-agent-entry').forEach(el => {
      el.addEventListener('click', () => {
        const id = (el as HTMLElement).dataset.agentId;
        if (id && this.onAgentClick) this.onAgentClick(id);
      });
    });
  }

  // Color gradient functions (same logic as Game)
  private gradientColor(value: number, inverted = false): string {
    if (inverted) value = 100 - value;
    value = Math.max(0, Math.min(100, value));
    let r: number, g: number;
    if (value > 50) {
      const t = (value - 50) / 50;
      r = Math.round(255 * (1 - t));
      g = Math.round(165 + 90 * t);
    } else {
      const t = value / 50;
      r = 255;
      g = Math.round(255 * t);
    }
    return `rgb(${r},${g},0)`;
  }

  private thirstColor(value: number): string {
    value = Math.max(0, Math.min(100, value));
    let r: number, g: number, b: number;
    if (value > 50) {
      const t = (value - 50) / 50;
      r = Math.round(100 * (1 - t) + 30 * t);
      g = Math.round(180 * (1 - t) + 120 * t);
      b = Math.round(220 + 35 * t);
    } else {
      const t = value / 50;
      r = Math.round(220 * (1 - t) + 100 * t);
      g = Math.round(60 * (1 - t) + 180 * t);
      b = Math.round(50 * (1 - t) + 220 * t);
    }
    return `rgb(${r},${g},${b})`;
  }

  private socialColor(value: number): string {
    value = Math.max(0, Math.min(100, value));
    let r: number, g: number, b: number;
    if (value > 50) {
      const t = (value - 50) / 50;
      r = Math.round(160 * (1 - t) + 180 * t);
      g = Math.round(120 * (1 - t) + 80 * t);
      b = Math.round(200 + 55 * t);
    } else {
      const t = value / 50;
      r = Math.round(150 * (1 - t) + 160 * t);
      g = Math.round(80 * (1 - t) + 120 * t);
      b = Math.round(80 * (1 - t) + 200 * t);
    }
    return `rgb(${r},${g},${b})`;
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
