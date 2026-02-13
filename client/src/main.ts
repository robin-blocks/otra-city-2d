import { Game } from './game/game.js';

const game = new Game();

async function start() {
  // Initialize PixiJS
  await game.init();

  // Wire up registration form
  const regPanel = document.getElementById('registration')!;
  const regSubmit = document.getElementById('reg-submit') as HTMLButtonElement;
  const regName = document.getElementById('reg-name') as HTMLInputElement;
  const regPreferred = document.getElementById('reg-preferred') as HTMLInputElement;
  const regOrigin = document.getElementById('reg-origin') as HTMLInputElement;
  const regType = document.getElementById('reg-type') as HTMLSelectElement;
  const regFrameworkGroup = document.getElementById('reg-framework-group')!;
  const regFramework = document.getElementById('reg-framework') as HTMLSelectElement;
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

      regPanel.style.display = 'none';
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

  // Show/hide framework dropdown based on type selection
  regType.addEventListener('change', () => {
    regFrameworkGroup.style.display = regType.value === 'AGENT' ? 'block' : 'none';
  });

  // Check for saved token
  const savedToken = sessionStorage.getItem('otra-token');
  if (savedToken) {
    try {
      regPanel.style.display = 'none';
      hud.style.display = 'block';
      await game.connect(savedToken);
    } catch (err) {
      console.warn('Saved token invalid, showing registration');
      sessionStorage.removeItem('otra-token');
      regPanel.style.display = 'block';
      hud.style.display = 'none';
    }
  }

  regSubmit.addEventListener('click', async () => {
    const fullName = regName.value.trim();
    const preferredName = regPreferred.value.trim();
    const origin = regOrigin.value.trim();

    if (!fullName || fullName.length < 2) {
      alert('Please enter a name (at least 2 characters)');
      return;
    }
    if (!origin) {
      alert('Please enter your place of origin');
      return;
    }

    regSubmit.disabled = true;
    regSubmit.textContent = 'Boarding...';

    try {
      const type = regType.value as 'HUMAN' | 'AGENT';
      const framework = type === 'AGENT' ? regFramework.value : undefined;
      const token = await game.register(fullName, preferredName, origin, type, framework);
      sessionStorage.setItem('otra-token', token);

      regPanel.style.display = 'none';
      hud.style.display = 'block';

      await game.connect(token);
    } catch (err: any) {
      alert(`Registration failed: ${err.message}`);
      regSubmit.disabled = false;
      regSubmit.textContent = 'Board the next train';
    }
  });
}

start().catch(console.error);
