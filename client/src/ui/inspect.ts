import type { InspectData, Passport, PerceptionUpdate, VisibleResident } from '@otra/shared';
import { getFrameworkStyle } from './framework-colors.js';

const EVENT_LABELS: Record<string, string> = {
  speak: 'Spoke',
  sleep: 'Fell asleep',
  wake: 'Woke up',
  enter_building: 'Entered building',
  exit_building: 'Left building',
  buy: 'Bought item',
  collect_ubi: 'Collected UBI',
  use_toilet: 'Used toilet',
  eat: 'Ate food',
  drink: 'Had a drink',
  bladder_accident: 'Had an accident',
  death: 'Died',
  arrival: 'Arrived in Otra City',
  give: 'Gave item',
  arrest: 'Arrested someone',
  book_suspect: 'Booked suspect',
  prison_release: 'Released from prison',
  law_violation: 'Broke the law',
};

export class InspectUI {
  private overlay: HTMLElement;
  private visible = false;
  private showTime = 0;
  onHide: (() => void) | null = null;

  constructor() {
    this.overlay = document.getElementById('inspect-overlay')!;

    // Click outside to close — ignore clicks within 100ms of opening (same event that triggered show)
    document.addEventListener('pointerdown', (e) => {
      if (!this.visible) return;
      if (Date.now() - this.showTime < 100) return;
      if (!this.overlay.contains(e.target as Node)) {
        this.hide();
      }
    });
  }

  show(data: InspectData): void {
    this.visible = true;
    this.showTime = Date.now();
    this.overlay.style.display = 'block';
    this.render(data);
  }

  /** Show inspect panel from local data (for spectator self-inspect, no server roundtrip) */
  showLocal(passport: Passport, self: PerceptionUpdate['self'], agentFramework?: string | null): void {
    this.visible = true;
    this.showTime = Date.now();
    this.overlay.style.display = 'block';

    const statusColor = self.status === 'dead' ? '#c33' : '#3c6';
    const statusLabel = self.status === 'dead' ? 'DECEASED' : 'ALIVE';

    const fwStyle = agentFramework ? getFrameworkStyle(agentFramework) : null;
    const frameworkRow = fwStyle
      ? `<div class="inspect-row"><span class="inspect-label">Framework:</span> <span style="color:${fwStyle.cssColor}">${this.escape(fwStyle.label)}</span></div>`
      : '';

    let html = `
      <div class="inspect-header">
        <div class="inspect-name">${this.escape(passport.full_name)}</div>
        <div class="inspect-passport">${this.escape(passport.passport_no)}</div>
      </div>
      <div class="inspect-details">
        <div class="inspect-row"><span class="inspect-label">Preferred name:</span> ${this.escape(passport.preferred_name)}</div>
        <div class="inspect-row"><span class="inspect-label">Type:</span> ${passport.type === 'AGENT' ? 'Agent' : 'Human'}</div>
        ${frameworkRow}
        <div class="inspect-row"><span class="inspect-label">Status:</span> <span style="color:${statusColor}">${statusLabel}</span></div>
      </div>
      <div class="inspect-events-title">Current State</div>
      <div class="inspect-events">
        <div class="inspect-event">Hunger: ${self.hunger.toFixed(1)}</div>
        <div class="inspect-event">Thirst: ${self.thirst.toFixed(1)}</div>
        <div class="inspect-event">Energy: ${self.energy.toFixed(1)}</div>
        <div class="inspect-event">Health: ${self.health.toFixed(1)}</div>
        <div class="inspect-event">Location: ${self.current_building || 'Outside'}</div>
        ${self.is_sleeping ? '<div class="inspect-event">💤 Sleeping</div>' : ''}
      </div>
    `;
    this.overlay.innerHTML = html;
  }

  /** Show a simplified inspect for another resident in spectator mode (limited data, with spectate button) */
  showOther(resident: VisibleResident): void {
    this.visible = true;
    this.showTime = Date.now();
    this.overlay.style.display = 'block';

    const fwStyle = resident.agent_framework ? getFrameworkStyle(resident.agent_framework) : null;
    const frameworkRow = fwStyle
      ? `<div class="inspect-row"><span class="inspect-label">Framework:</span> <span style="color:${fwStyle.cssColor}">${this.escape(fwStyle.label)}</span></div>`
      : '';

    const statusColor = resident.is_dead ? '#c33' : '#3c6';
    const statusLabel = resident.is_dead ? 'DECEASED' : 'ALIVE';
    const actionLabel = resident.action === 'sleeping' ? 'Sleeping' :
                        resident.action === 'walking' ? 'Walking' :
                        resident.action === 'dead' ? 'Dead' : 'Idle';

    let html = `
      <div class="inspect-header">
        <div class="inspect-name">${this.escape(resident.name)}</div>
      </div>
      <div class="inspect-details">
        ${frameworkRow}
        <div class="inspect-row"><span class="inspect-label">Status:</span> <span style="color:${statusColor}">${statusLabel}</span></div>
        <div class="inspect-row"><span class="inspect-label">Activity:</span> ${actionLabel}</div>
        ${resident.condition ? `<div class="inspect-row"><span class="inspect-label">Condition:</span> <span style="color:${resident.condition === 'critical' ? '#f33' : resident.condition === 'struggling' ? '#fc0' : '#3c6'}">${resident.condition}</span></div>` : ''}
        ${resident.is_wanted ? `<div class="inspect-row"><span class="inspect-label">Status:</span> <span style="color:#f33">Wanted</span></div>` : ''}
        ${resident.is_arrested ? `<div class="inspect-row"><span class="inspect-label">Status:</span> <span style="color:#f90">Arrested</span></div>` : ''}
        ${resident.is_police ? `<div class="inspect-row"><span class="inspect-label">Role:</span> <span style="color:#36f">Police Officer</span></div>` : ''}
      </div>
      <div class="inspect-actions">
        <a href="javascript:void(0)" class="inspect-spectate-btn" data-resident-id="${this.escape(resident.id)}">Spectate ${this.escape(resident.name)} →</a>
      </div>
    `;
    this.overlay.innerHTML = html;

    // Bind the spectate button click
    const btn = this.overlay.querySelector('.inspect-spectate-btn') as HTMLElement | null;
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const rid = btn.dataset.residentId;
        if (rid) {
          // Fetch passport_no from API, then redirect
          this.navigateToSpectate(rid);
        }
      });
    }
  }

  private async navigateToSpectate(residentId: string): Promise<void> {
    try {
      const res = await fetch(`/api/resident-by-id/${encodeURIComponent(residentId)}`);
      if (res.ok) {
        const data = await res.json();
        window.location.href = `/?follow=${encodeURIComponent(data.passport_no)}`;
      } else {
        // Fallback: just reload with the ID (won't work but better than nothing)
        console.error('Could not look up resident for spectate');
      }
    } catch {
      console.error('Failed to navigate to spectate');
    }
  }

  hide(): void {
    this.visible = false;
    this.overlay.style.display = 'none';
    this.onHide?.();
  }

  isVisible(): boolean {
    return this.visible;
  }

  private render(data: InspectData): void {
    const typeLabel = data.type === 'AGENT' ? 'Agent' : 'Human';
    const statusColor = data.status === 'ALIVE' ? '#3c6' :
                        data.status === 'DECEASED' ? '#c33' : '#888';

    const fwStyle = data.agent_framework ? getFrameworkStyle(data.agent_framework) : null;
    const frameworkRow = fwStyle
      ? `<div class="inspect-row"><span class="inspect-label">Framework:</span> <span style="color:${fwStyle.cssColor}">${this.escape(fwStyle.label)}</span></div>`
      : '';

    let html = `
      <div class="inspect-header">
        <div class="inspect-name">${this.escape(data.full_name)}</div>
        <div class="inspect-passport">${this.escape(data.passport_no)}</div>
      </div>
      <div class="inspect-details">
        <div class="inspect-row"><span class="inspect-label">Preferred name:</span> ${this.escape(data.preferred_name)}</div>
        <div class="inspect-row"><span class="inspect-label">From:</span> ${this.escape(data.place_of_origin)}</div>
        <div class="inspect-row"><span class="inspect-label">Type:</span> ${typeLabel}</div>
        ${frameworkRow}
        <div class="inspect-row"><span class="inspect-label">Status:</span> <span style="color:${statusColor}">${data.status}</span></div>
        ${data.condition ? `<div class="inspect-row"><span class="inspect-label">Condition:</span> <span style="color:${data.condition === 'critical' ? '#f33' : data.condition === 'struggling' ? '#fc0' : '#3c6'}">${data.condition}</span></div>` : ''}
        <div class="inspect-row"><span class="inspect-label">Location:</span> ${data.current_building ? this.escape(data.current_building) : 'Outside'}</div>
        <div class="inspect-row"><span class="inspect-label">Inventory:</span> ${data.inventory_count} item${data.inventory_count !== 1 ? 's' : ''}</div>
        ${data.employment ? `<div class="inspect-row"><span class="inspect-label">Job:</span> ${this.escape(data.employment.job)}${data.employment.on_shift ? ' (on shift)' : ''}</div>` : ''}
        ${data.law_breaking && data.law_breaking.length > 0 ? `<div class="inspect-row"><span class="inspect-label">Wanted for:</span> <span style="color:#f33">${data.law_breaking.map(l => this.escape(l)).join(', ')}</span></div>` : ''}
        ${data.is_imprisoned ? `<div class="inspect-row"><span class="inspect-label">Status:</span> <span style="color:#f90">Imprisoned</span></div>` : ''}
      </div>
      <div class="inspect-events-title">Recent Activity</div>
      <div class="inspect-events">
    `;

    if (data.recent_events.length === 0) {
      html += '<div class="inspect-no-events">No recent activity</div>';
    } else {
      for (const event of data.recent_events) {
        const label = EVENT_LABELS[event.type] || event.type;
        const time = new Date(event.timestamp).toLocaleTimeString();
        let detail = '';
        if (event.type === 'speak' && event.data.text) {
          detail = ` — "${this.escape(String(event.data.text))}"`;
        } else if (event.type === 'buy' && event.data.item_type) {
          detail = ` — ${this.escape(String(event.data.item_type))}`;
        } else if (event.type === 'death' && event.data.cause) {
          detail = ` — ${this.escape(String(event.data.cause))}`;
        }
        html += `<div class="inspect-event"><span class="inspect-event-time">${time}</span> ${label}${detail}</div>`;
      }
    }

    html += '</div>';
    this.overlay.innerHTML = html;
  }

  private escape(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
