import { getRun, type AgentResult } from '../api.js';

export async function renderSpectator(app: HTMLElement, runId: string): Promise<void> {
  app.innerHTML = `
    <div class="spectator-layout">
      <div class="spectator-sidebar" id="agent-sidebar">
        <div class="section-header">Agents</div>
        <div class="loading">Loading...</div>
      </div>
      <div class="spectator-viewport" id="viewport">
        <div class="loading" style="padding-top: 40%;">Select an agent or waiting for run data...</div>
      </div>
      <div class="spectator-stats" id="stats-bar">
        <span style="color: var(--text-muted);">Click an agent to spectate</span>
      </div>
    </div>
  `;

  try {
    const run = await getRun(runId);
    if (!run.results) {
      document.getElementById('agent-sidebar')!.innerHTML = `
        <div class="section-header">Agents</div>
        <div class="empty-state" style="padding: 1rem 0;">No results yet for this run.</div>
      `;
      return;
    }

    const agents = run.results.agents;
    renderSidebar(agents, runId);
  } catch {
    document.getElementById('agent-sidebar')!.innerHTML = `
      <div class="section-header">Agents</div>
      <div class="empty-state" style="padding: 1rem 0;">Failed to load run data</div>
    `;
  }
}

function renderSidebar(agents: AgentResult[], runId: string): void {
  const sidebar = document.getElementById('agent-sidebar')!;
  const sorted = [...agents].sort((a, b) => b.otra_score - a.otra_score);

  const items = sorted.map((a, i) => `
    <div class="sidebar-agent" data-passport="${esc(a.passport_no)}" data-index="${i}">
      <span>${esc(a.display_name)}</span>
      <span class="agent-score">${a.otra_score.toFixed(1)}</span>
    </div>
  `).join('');

  sidebar.innerHTML = `
    <div class="section-header">Agents &mdash; ${esc(runId)}</div>
    ${items}
    <div style="margin-top: 1rem;">
      <a href="#/runs/${esc(runId)}" class="btn btn-outline" style="width: 100%; text-align: center;">Full Results</a>
    </div>
  `;

  // Click handlers
  sidebar.querySelectorAll('.sidebar-agent').forEach(el => {
    el.addEventListener('click', () => {
      const passport = (el as HTMLElement).dataset.passport!;
      const idx = parseInt((el as HTMLElement).dataset.index!, 10);
      selectAgent(sorted[idx], passport);

      // Update active state
      sidebar.querySelectorAll('.sidebar-agent').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
    });
  });
}

function selectAgent(agent: AgentResult, passport: string): void {
  const viewport = document.getElementById('viewport')!;
  const statsBar = document.getElementById('stats-bar')!;

  // Load spectator iframe — bench instance at bench-internal.otra.city
  const spectatorUrl = `https://bench-internal.otra.city/?follow=${encodeURIComponent(passport)}`;
  viewport.innerHTML = `<iframe src="${esc(spectatorUrl)}" allowfullscreen></iframe>`;

  // Stats bar with need info
  const d = agent.details;
  const alive = d.survived_full_run;
  statsBar.innerHTML = `
    <div class="need-bars">
      <div class="need-bar-item">
        <div class="need-bar-label">${esc(agent.display_name)} &mdash;
          <span class="${alive ? 'status-alive' : 'status-dead'}">${alive ? 'Survived' : 'Dead'}</span>
          &mdash; ${d.hours_alive.toFixed(1)}h alive
        </div>
      </div>
      <div class="need-bar-item">
        <div class="need-bar-label">Avg Needs</div>
        ${needBar(d.avg_needs)}
      </div>
      <div class="need-bar-item">
        <div class="need-bar-label">Social</div>
        ${needBar(d.avg_social_need)}
      </div>
      <div class="need-bar-item">
        <div class="need-bar-label">Wallet</div>
        <div style="font-family: var(--font-mono); font-size: 0.85rem;">${d.final_wallet}Q (peak: ${d.wallet_high}Q)</div>
      </div>
    </div>
  `;
}

function needBar(value: number): string {
  const pct = Math.max(0, Math.min(100, value));
  const cls = pct > 50 ? 'good' : pct > 25 ? 'warn' : 'crit';
  return `
    <div class="need-bar-track">
      <div class="need-bar-fill ${cls}" style="width: ${pct}%;"></div>
    </div>
  `;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
