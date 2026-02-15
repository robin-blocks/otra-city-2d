import type { InspectData, Passport, PerceptionUpdate } from '@otra/shared';

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
};

export class InspectUI {
  private overlay: HTMLElement;
  private visible = false;

  constructor() {
    this.overlay = document.getElementById('inspect-overlay')!;
  }

  show(data: InspectData): void {
    this.visible = true;
    this.overlay.style.display = 'block';
    this.render(data);
  }

  /** Show inspect panel from local data (for spectator self-inspect, no server roundtrip) */
  showLocal(passport: Passport, self: PerceptionUpdate['self']): void {
    this.visible = true;
    this.overlay.style.display = 'block';

    const statusColor = self.status === 'dead' ? '#c33' : '#3c6';
    const statusLabel = self.status === 'dead' ? 'DECEASED' : 'ALIVE';

    let html = `
      <div class="inspect-header">
        <div class="inspect-name">${this.escape(passport.full_name)}</div>
        <div class="inspect-passport">${this.escape(passport.passport_no)}</div>
      </div>
      <div class="inspect-details">
        <div class="inspect-row"><span class="inspect-label">Preferred name:</span> ${this.escape(passport.preferred_name)}</div>
        <div class="inspect-row"><span class="inspect-label">Type:</span> ${passport.type === 'AGENT' ? 'Agent' : 'Human'}</div>
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

  hide(): void {
    this.visible = false;
    this.overlay.style.display = 'none';
  }

  isVisible(): boolean {
    return this.visible;
  }

  private render(data: InspectData): void {
    const typeLabel = data.type === 'AGENT' ? 'Agent' : 'Human';
    const statusColor = data.status === 'ALIVE' ? '#3c6' :
                        data.status === 'DECEASED' ? '#c33' : '#888';

    let html = `
      <div class="inspect-header">
        <div class="inspect-name">${this.escape(data.full_name)}</div>
        <div class="inspect-passport">${this.escape(data.passport_no)}</div>
      </div>
      <div class="inspect-details">
        <div class="inspect-row"><span class="inspect-label">Preferred name:</span> ${this.escape(data.preferred_name)}</div>
        <div class="inspect-row"><span class="inspect-label">From:</span> ${this.escape(data.place_of_origin)}</div>
        <div class="inspect-row"><span class="inspect-label">Type:</span> ${typeLabel}</div>
        <div class="inspect-row"><span class="inspect-label">Status:</span> <span style="color:${statusColor}">${data.status}</span></div>
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
