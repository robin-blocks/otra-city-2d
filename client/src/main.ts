import { Game } from './game/game.js';
import { getFrameworkStyle } from './ui/framework-colors.js';

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

  // Check for ?follow= param (spectator mode)
  const urlParams = new URLSearchParams(window.location.search);
  const followPassport = urlParams.get('follow');
  if (followPassport) {
    // Show loading state immediately in the landing modal
    const landingBody = landing.querySelector('.landing-body') as HTMLElement;
    if (landingBody) {
      landingBody.innerHTML = `<p style="text-align:center; color:#888; margin-top:20px;">Connecting to <strong style="color:#3a7;">${escapeHtml(followPassport)}</strong>…</p>`;
    }

    try {
      const res = await fetch(`/api/resident/${encodeURIComponent(followPassport)}`);
      if (!res.ok) throw new Error('Resident not found');
      const resident = await res.json();

      // Build banner with optional framework badge
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

      // Only reveal the spectator view once everything is loaded
      landing.style.display = 'none';
      hud.style.display = 'block';
      spectatorBanner.style.display = 'block';
    } catch (err) {
      console.error('Failed to spectate:', err);
      landing.style.display = 'none';
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
      await game.connect(savedToken);
    } catch (err) {
      console.warn('Saved token invalid, showing landing');
      sessionStorage.removeItem('otra-token');
      landing.style.display = 'block';
      hud.style.display = 'none';
    }
  }

  // Start activity feed if landing page is showing
  if (landing.style.display !== 'none') {
    startLandingFeed();
  }
}

interface FeedEvent {
  id: number;
  timestamp: number;
  type: string;
  actor: { name: string; passport_no: string } | null;
  target: { name: string; passport_no: string } | null;
  text: string;
}

function startLandingFeed(): void {
  const feedList = document.getElementById('landing-feed-list')!;
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
      // Silent fail — landing feed is non-critical
    }
  }

  // Fetch immediately, then every 8 seconds
  fetchFeed();
  const intervalId = setInterval(fetchFeed, 8000);

  // Stop polling if landing page is hidden (user navigates to spectate mode)
  const observer = new MutationObserver(() => {
    const landing = document.getElementById('landing');
    if (landing && landing.style.display === 'none') {
      clearInterval(intervalId);
      observer.disconnect();
    }
  });
  observer.observe(document.getElementById('landing')!, {
    attributes: true, attributeFilter: ['style'],
  });
}

start().catch(console.error);
