import { GAME_DAY_SECONDS } from '@otra/shared';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const SPEEDS = [1, 2, 4, 8];

export class SpectatorTimeline {
  private container: HTMLElement;
  private mode: 'live' | 'replay' = 'live';
  private duration = 0;
  private currentTime = 0;
  private playing = true;
  private speed = 1;
  private events: Array<{ world_time: number; type: string }> = [];

  onSeek: ((worldTime: number) => void) | null = null;
  onPlayPause: (() => void) | null = null;
  onSpeedChange: ((speed: number) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.render();
  }

  setMode(mode: 'live' | 'replay'): void {
    this.mode = mode;
    this.render();
  }

  setDuration(totalWorldTime: number): void {
    this.duration = totalWorldTime;
    this.render();
  }

  setEvents(events: Array<{ world_time: number; type: string }>): void {
    this.events = events;
    this.render();
  }

  updateTime(currentWorldTime: number): void {
    this.currentTime = currentWorldTime;

    if (this.mode === 'live') {
      // Update just the time display
      const timeEl = this.container.querySelector('.spec-timeline-time');
      if (timeEl) timeEl.innerHTML = `<span class="spec-live-dot"></span>${this.formatGameTime(currentWorldTime)}`;
    } else {
      // Update cursor position + time display
      const bar = this.container.querySelector('.spec-timeline-bar') as HTMLElement;
      const cursor = this.container.querySelector('.spec-timeline-cursor') as HTMLElement;
      const progress = this.container.querySelector('.spec-timeline-progress') as HTMLElement;
      const timeEl = this.container.querySelector('.spec-timeline-time');

      if (bar && cursor && this.duration > 0) {
        const pct = Math.min(1, currentWorldTime / this.duration) * 100;
        cursor.style.left = `${pct}%`;
        if (progress) progress.style.width = `${pct}%`;
      }
      if (timeEl) timeEl.textContent = `${this.formatGameTime(currentWorldTime)} / ${this.formatGameTime(this.duration)}`;
    }
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
    const btn = this.container.querySelector('.spec-play-btn');
    if (btn) btn.textContent = playing ? '\u23F8' : '\u25B6';
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    const btn = this.container.querySelector('.spec-speed-btn');
    if (btn) btn.textContent = `${speed}x`;
  }

  private render(): void {
    if (this.mode === 'live') {
      this.container.innerHTML = `
        <div class="spec-timeline-time"><span class="spec-live-dot"></span>${this.formatGameTime(this.currentTime)}</div>
      `;
    } else {
      // Replay mode: play/pause + speed + timeline bar + time
      const markersHtml = this.renderMarkers();
      this.container.innerHTML = `
        <div class="spec-play-btn">${this.playing ? '\u23F8' : '\u25B6'}</div>
        <div class="spec-speed-btn">${this.speed}x</div>
        <div class="spec-timeline-bar">
          <div class="spec-timeline-progress" style="width:0%"></div>
          ${markersHtml}
          <div class="spec-timeline-cursor" style="left:0%"></div>
        </div>
        <div class="spec-timeline-time">${this.formatGameTime(this.currentTime)} / ${this.formatGameTime(this.duration)}</div>
      `;

      // Wire event handlers
      const playBtn = this.container.querySelector('.spec-play-btn');
      playBtn?.addEventListener('click', () => this.onPlayPause?.());

      const speedBtn = this.container.querySelector('.spec-speed-btn');
      speedBtn?.addEventListener('click', () => {
        const idx = SPEEDS.indexOf(this.speed);
        const next = SPEEDS[(idx + 1) % SPEEDS.length];
        this.onSpeedChange?.(next);
      });

      const bar = this.container.querySelector('.spec-timeline-bar') as HTMLElement;
      if (bar) {
        const seekFromEvent = (e: MouseEvent) => {
          const rect = bar.getBoundingClientRect();
          const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
          this.onSeek?.(pct * this.duration);
        };

        let dragging = false;
        bar.addEventListener('mousedown', (e) => {
          dragging = true;
          seekFromEvent(e);
        });
        window.addEventListener('mousemove', (e) => {
          if (dragging) seekFromEvent(e);
        });
        window.addEventListener('mouseup', () => { dragging = false; });
      }
    }
  }

  private renderMarkers(): string {
    if (this.duration <= 0 || this.events.length === 0) return '';

    return this.events.map(ev => {
      const pct = (ev.world_time / this.duration) * 100;
      const color = this.markerColor(ev.type);
      return `<div class="spec-timeline-marker" style="left:${pct}%;background:${color}"></div>`;
    }).join('');
  }

  private markerColor(type: string): string {
    if (type === 'death' || type === 'need_critical') return '#c33';
    if (type === 'need_recovered') return '#3c6';
    if (type === 'speech_received') return '#38f';
    return '#666';
  }

  private formatGameTime(worldTimeSec: number): string {
    const daySeconds = worldTimeSec % GAME_DAY_SECONDS;
    const hour = Math.floor(daySeconds / 3600);
    const minute = Math.floor((daySeconds % 3600) / 60);
    let dayOfYear = Math.floor(worldTimeSec / GAME_DAY_SECONDS);

    let month = 0;
    while (month < 11 && dayOfYear >= DAYS_IN_MONTH[month]) {
      dayOfYear -= DAYS_IN_MONTH[month];
      month++;
    }
    const dayOfMonth = dayOfYear + 1;

    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return `${time} ${dayOfMonth} ${MONTH_NAMES[month]}`;
  }
}
