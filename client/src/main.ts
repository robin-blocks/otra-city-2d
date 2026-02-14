import { Game } from './game/game.js';

const game = new Game();

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
    try {
      const res = await fetch(`/api/resident/${encodeURIComponent(followPassport)}`);
      if (!res.ok) throw new Error('Resident not found');
      const resident = await res.json();

      landing.style.display = 'none';
      hud.style.display = 'block';
      spectatorBanner.style.display = 'block';
      spectatorBanner.textContent = `Spectating: ${resident.preferred_name} (${resident.passport_no})`;

      await game.spectate(resident.id);
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
      await game.connect(savedToken);
    } catch (err) {
      console.warn('Saved token invalid, showing landing');
      sessionStorage.removeItem('otra-token');
      landing.style.display = 'block';
      hud.style.display = 'none';
    }
  }
}

start().catch(console.error);
