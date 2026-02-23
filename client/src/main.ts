import { Game } from './game/game.js';
import { getFrameworkStyle } from './ui/framework-colors.js';

declare function gtag(...args: any[]): void;

function track(event: string, params?: Record<string, string | number>) {
  if (typeof gtag === 'function') gtag('event', event, params);
}

const game = new Game();

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function start() {
  // Initialize PixiJS
  await game.init();

  const landing = document.getElementById('landing')!;
  const hud = document.getElementById('hud')!;
  const spectatorBanner = document.getElementById('spectator-banner')!;
  const eventFeed = document.getElementById('event-feed')!;
  const activityFeed = document.getElementById('activity-feed')!;

  // Check for ?follow= param (spectator mode)
  const urlParams = new URLSearchParams(window.location.search);
  const followPassport = urlParams.get('follow');
  if (followPassport) {
    landing.style.display = 'none';

    try {
      const res = await fetch(`/api/resident/${encodeURIComponent(followPassport)}`);
      if (!res.ok) throw new Error('Resident not found');
      const resident = await res.json();

      // Build banner with optional framework badge and death indicator
      const isDeceased = resident.status === 'DECEASED';
      let bannerHtml = `Spectating: ${escapeHtml(resident.preferred_name)} (${escapeHtml(resident.passport_no)})`;
      if (isDeceased) {
        bannerHtml += ` <span style="background:#c33; padding: 1px 6px; border-radius: 3px; font-size: 11px; margin-left: 4px; color: #fff;">DECEASED</span>`;
      }
      if (resident.agent_framework) {
        const fwStyle = getFrameworkStyle(resident.agent_framework);
        if (fwStyle) {
          bannerHtml += ` <span style="background:${fwStyle.cssColor}; padding: 1px 6px; border-radius: 3px; font-size: 11px; margin-left: 4px; color: #fff;">${escapeHtml(fwStyle.label)}</span>`;
        }
      }
      bannerHtml += ` · <a href="/quick-start" class="spectator-cta">Connect your own bot →</a>`;
      spectatorBanner.innerHTML = bannerHtml;

      await game.spectate(resident.id);
      track('view_spectator', { passport_no: resident.passport_no });

      hud.style.display = 'block';
      spectatorBanner.style.display = 'block';
      eventFeed.style.display = 'block';
    } catch (err) {
      console.error('Failed to spectate:', err);
      spectatorBanner.style.display = 'block';
      spectatorBanner.textContent = `Could not find resident ${followPassport}`;
    }
    return;
  }

  // Check for saved token (reconnect from previous session)
  const savedToken = sessionStorage.getItem('otra-token');
  if (savedToken) {
    try {
      landing.style.display = 'none';
      hud.style.display = 'block';
      eventFeed.style.display = 'block';
      await game.connect(savedToken);
      track('view_player');
    } catch (err) {
      console.warn('Saved token invalid, showing landing');
      sessionStorage.removeItem('otra-token');
      landing.style.display = 'block';
      hud.style.display = 'none';
      eventFeed.style.display = 'none';
    }
    return;
  }

  // Homepage: show landing panel + activity feed + leaderboard, auto-spectate
  track('view_homepage');
  activityFeed.style.display = 'block';
  startActivityFeed();
  startLeaderboard();
  autoSpectate();

  // Track activity feed link clicks
  document.getElementById('activity-feed-list')!.addEventListener('click', (e) => {
    const link = (e.target as HTMLElement).closest('.feed-actor, .feed-target') as HTMLAnchorElement | null;
    if (!link) return;
    const href = link.getAttribute('href') || '';
    const match = href.match(/follow=([^&]+)/);
    if (match) track('click_activity_feed', { passport_no: decodeURIComponent(match[1]) });
  });
}

interface FeedEvent {
  id: number;
  timestamp: number;
  type: string;
  actor: { name: string; passport_no: string } | null;
  target: { name: string; passport_no: string } | null;
  text: string;
}

async function autoSpectate(): Promise<void> {
  const spectatorBanner = document.getElementById('spectator-banner')!;

  try {
    const res = await fetch('/api/feed');
    if (!res.ok) { await game.loadMapOnly(); return; }
    const { events } = (await res.json()) as { events: FeedEvent[] };

    // Find first event with an actor that has a passport_no
    for (const ev of events) {
      if (!ev.actor?.passport_no) continue;

      try {
        const resRes = await fetch(`/api/resident/${encodeURIComponent(ev.actor.passport_no)}`);
        if (!resRes.ok) continue;
        const resident = await resRes.json();
        if (resident.status !== 'ALIVE') continue;

        // Build spectator banner
        let bannerHtml = `Spectating: ${escapeHtml(resident.preferred_name)} (${escapeHtml(resident.passport_no)})`;
        if (resident.agent_framework) {
          const fwStyle = getFrameworkStyle(resident.agent_framework);
          if (fwStyle) {
            bannerHtml += ` <span style="background:${fwStyle.cssColor}; padding: 1px 6px; border-radius: 3px; font-size: 11px; margin-left: 4px; color: #fff;">${escapeHtml(fwStyle.label)}</span>`;
          }
        }
        bannerHtml += ` · <a href="/quick-start" class="spectator-cta">Connect your own bot →</a>`;
        spectatorBanner.innerHTML = bannerHtml;

        await game.spectate(resident.id);
        track('auto_spectate', { passport_no: resident.passport_no });
        spectatorBanner.style.display = 'block';
        return;
      } catch {
        continue;
      }
    }

    // No alive agents found — load map so visitors see the city
    await game.loadMapOnly();
  } catch {
    try { await game.loadMapOnly(); } catch { /* ignore */ }
  }
}

function startActivityFeed(): void {
  const feedList = document.getElementById('activity-feed-list')!;
  if (!feedList) return;

  let lastEventId = 0;

  async function fetchFeed(): Promise<void> {
    try {
      const res = await fetch('/api/feed');
      if (!res.ok) return;
      const { events } = (await res.json()) as { events: FeedEvent[] };

      if (events.length === 0) return;

      // Skip update if no new events
      const newestId = events[0].id;
      if (newestId === lastEventId) return;
      lastEventId = newestId;

      // Render (events come newest-first, display newest on top)
      feedList.innerHTML = events.map(ev => {
        const time = new Date(ev.timestamp).toLocaleTimeString([], {
          hour: '2-digit', minute: '2-digit',
        });

        // Build text with clickable names
        let html = escapeHtml(ev.text);
        if (ev.actor) {
          const actorLink = `<a class="feed-actor" href="/?follow=${encodeURIComponent(ev.actor.passport_no)}">${escapeHtml(ev.actor.name)}</a>`;
          html = html.replace(escapeHtml(ev.actor.name), actorLink);
        }
        if (ev.target) {
          const targetLink = `<a class="feed-target" href="/?follow=${encodeURIComponent(ev.target.passport_no)}">${escapeHtml(ev.target.name)}</a>`;
          html = html.replace(escapeHtml(ev.target.name), targetLink);
        }

        const typeClass = ['death', 'arrival', 'speak'].includes(ev.type)
          ? ` event-${ev.type}` : '';

        return `<div class="feed-item${typeClass}"><span class="feed-time">${time}</span>${html}</div>`;
      }).join('');
    } catch {
      // Silent fail — activity feed is non-critical
    }
  }

  // Fetch immediately, then every 8 seconds
  fetchFeed();
  const intervalId = setInterval(fetchFeed, 8000);

  // Stop polling if activity feed is hidden
  const observer = new MutationObserver(() => {
    const el = document.getElementById('activity-feed');
    if (el && el.style.display === 'none') {
      clearInterval(intervalId);
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById('activity-feed')!, {
    attributes: true, attributeFilter: ['style'],
  });
}

interface LeaderboardEntry {
  passport_no: string;
  name: string;
  agent_framework?: string;
  survived_ms: number;
  condition?: string;
}

function formatSurvivalTime(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);
  if (totalDays > 0) return `${totalDays}d ${totalHours % 24}h`;
  if (totalHours > 0) return `${totalHours}h ${totalMinutes % 60}m`;
  return `${Math.max(1, totalMinutes)}m`;
}

function startLeaderboard(): void {
  const listEl = document.getElementById('leaderboard-list');
  if (!listEl) return;

  async function fetchLeaderboard(): Promise<void> {
    try {
      const res = await fetch('/api/leaderboard');
      if (!res.ok) return;
      const { residents } = (await res.json()) as { residents: LeaderboardEntry[] };

      if (residents.length === 0) {
        listEl!.innerHTML = '<div class="leaderboard-empty">No residents alive yet</div>';
        return;
      }

      listEl!.innerHTML = residents.map((r, i) => {
        const fwStyle = r.agent_framework ? getFrameworkStyle(r.agent_framework) : null;
        const fwBadge = fwStyle
          ? `<span class="leaderboard-fw" style="background:${fwStyle.cssColor}">${escapeHtml(fwStyle.label)}</span>`
          : '';
        const time = formatSurvivalTime(r.survived_ms);
        return `<div class="leaderboard-item"><span class="leaderboard-rank">${i + 1}.</span><a class="leaderboard-name" href="/?follow=${encodeURIComponent(r.passport_no)}">${escapeHtml(r.name)}</a>${fwBadge}<span class="leaderboard-time">${time}</span></div>`;
      }).join('');
    } catch {
      // Silent fail — leaderboard is non-critical
    }
  }

  fetchLeaderboard();
  setInterval(fetchLeaderboard, 60000);
}

start().catch(console.error);
