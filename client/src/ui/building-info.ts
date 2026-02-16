interface BuildingData {
  name: string;
  items?: Array<{ name: string; price: number; stock: number; description: string }>;
  petitions?: Array<{ category: string; description: string; votes_for: number; votes_against: number }>;
  jobs?: Array<{ title: string; wage: number; shift_hours: number; openings: number; description: string }>;
  ubi_amount?: number;
  ubi_cooldown_hours?: number;
  alive_residents?: number;
  next_train_seconds?: number;
  queue_size?: number;
  bounty_per_body?: number;
  uncollected_bodies?: number;
  laws?: Array<{ name: string; description: string; sentence_hours: number }>;
  arrest_bounty?: number;
  current_prisoners?: number;
  wanted_count?: number;
}

interface BuildingsResponse {
  buildings: Record<string, BuildingData>;
}

export class BuildingInfoUI {
  private overlay: HTMLElement;
  private visible = false;
  private showTime = 0;
  private cache: BuildingsResponse | null = null;
  private cacheTime = 0;
  private static CACHE_TTL_MS = 10_000;
  onHide: (() => void) | null = null;

  constructor() {
    this.overlay = document.getElementById('building-info-overlay')!;

    // Click outside to close (same 100ms debounce pattern as InspectUI)
    document.addEventListener('pointerdown', (e) => {
      if (!this.visible) return;
      if (Date.now() - this.showTime < 100) return;
      if (!this.overlay.contains(e.target as Node)) {
        this.hide();
      }
    });
  }

  async show(buildingId: string): Promise<void> {
    this.visible = true;
    this.showTime = Date.now();
    this.overlay.style.display = 'block';

    // Show loading state
    this.overlay.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">Loading…</div>';

    const data = await this.fetchData();
    if (!data || !this.visible) return;

    const building = data.buildings[buildingId];
    if (!building) {
      this.overlay.innerHTML = '<div style="text-align:center;color:#888;padding:20px;">Unknown building</div>';
      return;
    }

    this.render(buildingId, building);
  }

  hide(): void {
    this.visible = false;
    this.overlay.style.display = 'none';
    this.onHide?.();
  }

  isVisible(): boolean {
    return this.visible;
  }

  private async fetchData(): Promise<BuildingsResponse | null> {
    if (this.cache && Date.now() - this.cacheTime < BuildingInfoUI.CACHE_TTL_MS) {
      return this.cache;
    }
    try {
      const res = await fetch('/api/buildings');
      if (!res.ok) return null;
      this.cache = await res.json() as BuildingsResponse;
      this.cacheTime = Date.now();
      return this.cache;
    } catch {
      return null;
    }
  }

  private render(buildingId: string, data: BuildingData): void {
    let html = `
      <div class="building-header">
        <div class="building-name">${this.esc(data.name)}</div>
      </div>
    `;

    switch (buildingId) {
      case 'council-supplies':
        html += this.renderShop(data);
        break;
      case 'council-hall':
        html += this.renderCouncilHall(data);
        break;
      case 'bank':
        html += this.renderBank(data);
        break;
      case 'council-toilet':
        html += this.renderToilet();
        break;
      case 'train-station':
        html += this.renderTrainStation(data);
        break;
      case 'council-mortuary':
        html += this.renderMortuary(data);
        break;
      case 'police-station':
        html += this.renderPoliceStation(data);
        break;
      default:
        html += '<div class="building-empty">No information available</div>';
    }

    this.overlay.innerHTML = html;
  }

  private renderShop(data: BuildingData): string {
    if (!data.items || data.items.length === 0) {
      return '<div class="building-empty">Shop is empty</div>';
    }
    let html = '<div class="building-section-title">STOCK</div>';
    for (const item of data.items) {
      const stockColor = item.stock > 0 ? '#3c6' : '#c33';
      const stockText = item.stock > 0 ? `${item.stock} in stock` : 'OUT OF STOCK';
      html += `
        <div class="building-item">
          <div class="building-item-row">
            <span class="building-item-name">${this.esc(item.name)}</span>
            <span class="building-item-price">Ɋ${item.price}</span>
          </div>
          <div class="building-item-row">
            <span class="building-item-detail">${this.esc(item.description)}</span>
            <span style="color:${stockColor};font-size:11px;white-space:nowrap;margin-left:8px;">${stockText}</span>
          </div>
        </div>`;
    }
    return html;
  }

  private renderCouncilHall(data: BuildingData): string {
    let html = '';

    // Petitions
    html += '<div class="building-section-title">PETITIONS</div>';
    if (!data.petitions || data.petitions.length === 0) {
      html += '<div class="building-empty">No open petitions</div>';
    } else {
      for (const p of data.petitions) {
        const desc = p.description.length > 80 ? p.description.slice(0, 77) + '…' : p.description;
        html += `
          <div class="building-petition">
            <div class="building-petition-category">${this.esc(p.category)}</div>
            <div class="building-petition-desc">${this.esc(desc)}</div>
            <div class="building-petition-votes">
              <span class="building-petition-for">▲ ${p.votes_for}</span>
              <span class="building-petition-against" style="margin-left:10px;">▼ ${p.votes_against}</span>
            </div>
          </div>`;
      }
    }

    // Jobs
    html += '<div class="building-section-title">JOBS</div>';
    if (!data.jobs || data.jobs.length === 0) {
      html += '<div class="building-empty">No jobs available</div>';
    } else {
      for (const j of data.jobs) {
        const openColor = j.openings > 0 ? '#3c6' : '#c33';
        const openText = j.openings > 0 ? `${j.openings} opening${j.openings !== 1 ? 's' : ''}` : 'Full';
        html += `
          <div class="building-item">
            <div class="building-item-row">
              <span class="building-item-name">${this.esc(j.title)}</span>
              <span class="building-item-price">Ɋ${j.wage}/shift</span>
            </div>
            <div class="building-item-row">
              <span class="building-item-detail">${j.shift_hours}h shifts</span>
              <span style="color:${openColor};font-size:11px;">${openText}</span>
            </div>
          </div>`;
      }
    }

    return html;
  }

  private renderBank(data: BuildingData): string {
    return `
      <div class="building-stat"><span class="building-stat-label">UBI payout:</span> <span class="building-stat-value">Ɋ${data.ubi_amount ?? 15} per day</span></div>
      <div class="building-stat"><span class="building-stat-label">Cooldown:</span> <span class="building-stat-value">${data.ubi_cooldown_hours ?? 24} hours between collections</span></div>
      <div class="building-stat"><span class="building-stat-label">Alive residents:</span> <span class="building-stat-value">${data.alive_residents ?? '?'}</span></div>
    `;
  }

  private renderToilet(): string {
    return `
      <div class="building-stat"><span class="building-stat-label">Effect:</span> <span class="building-stat-value">Restores bladder to full</span></div>
      <div class="building-stat"><span class="building-stat-label">Cost:</span> <span class="building-stat-value">Free</span></div>
    `;
  }

  private renderTrainStation(data: BuildingData): string {
    const gameSecs = data.next_train_seconds ?? 0;
    const gameMins = Math.floor(gameSecs / 60);
    const gameRemSecs = Math.floor(gameSecs % 60);
    const eta = `${gameMins}m ${String(gameRemSecs).padStart(2, '0')}s`;
    return `
      <div class="building-stat"><span class="building-stat-label">Next train:</span> <span class="building-stat-value">${eta} (game-time)</span></div>
      <div class="building-stat"><span class="building-stat-label">Residents queued:</span> <span class="building-stat-value">${data.queue_size ?? 0}</span></div>
      <div class="building-item-detail" style="margin-top:8px;">New residents arrive by train. Trains run every 15 game-minutes.</div>
    `;
  }

  private renderMortuary(data: BuildingData): string {
    const bodyCount = data.uncollected_bodies ?? 0;
    const bodyColor = bodyCount > 0 ? '#c66' : '#3c6';
    return `
      <div class="building-stat"><span class="building-stat-label">Bounty per body:</span> <span class="building-stat-value">Ɋ${data.bounty_per_body ?? 5}</span></div>
      <div class="building-stat"><span class="building-stat-label">Uncollected bodies:</span> <span class="building-stat-value" style="color:${bodyColor}">${bodyCount}</span></div>
      <div class="building-item-detail" style="margin-top:8px;">Collect bodies from the streets and process them here for a reward.</div>
    `;
  }

  private renderPoliceStation(data: BuildingData): string {
    let html = '';

    // Laws
    html += '<div class="building-section-title">CITY LAWS</div>';
    if (!data.laws || data.laws.length === 0) {
      html += '<div class="building-empty">No laws defined</div>';
    } else {
      for (const law of data.laws) {
        html += `
          <div class="building-item">
            <div class="building-item-row">
              <span class="building-item-name">${this.esc(law.name)}</span>
              <span class="building-item-price">${law.sentence_hours}h sentence</span>
            </div>
            <div class="building-item-row">
              <span class="building-item-detail">${this.esc(law.description)}</span>
            </div>
          </div>`;
      }
    }

    // Stats
    html += '<div class="building-section-title">STATS</div>';
    html += `
      <div class="building-stat"><span class="building-stat-label">Bounty per arrest:</span> <span class="building-stat-value">Ɋ${data.arrest_bounty ?? 10}</span></div>
      <div class="building-stat"><span class="building-stat-label">Current prisoners:</span> <span class="building-stat-value">${data.current_prisoners ?? 0}</span></div>
      <div class="building-stat"><span class="building-stat-label">Wanted residents:</span> <span class="building-stat-value" style="color:${(data.wanted_count ?? 0) > 0 ? '#c66' : '#3c6'}">${data.wanted_count ?? 0}</span></div>
    `;
    html += '<div class="building-item-detail" style="margin-top:8px;">Police officers earn Ɋ10 per booking plus shift wages. Apply at Council Hall.</div>';

    return html;
  }

  private esc(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
