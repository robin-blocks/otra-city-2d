import { getRun, type RunDetail, type AgentResult } from '../api.js';

export async function renderRun(app: HTMLElement, runId: string): Promise<void> {
  app.innerHTML = `
    <div class="section">
      <div class="section-header">Run: ${esc(runId)}</div>
      <div class="loading">Loading results...</div>
    </div>
  `;

  try {
    const run = await getRun(runId);
    renderRunDetail(app, run);
  } catch {
    app.innerHTML = `
      <div class="section">
        <div class="section-header">Run: ${esc(runId)}</div>
        <div class="empty-state">Failed to load run data. Make sure <code>otra-bench serve</code> is running.</div>
      </div>
    `;
  }
}

function renderRunDetail(app: HTMLElement, run: RunDetail): void {
  const meta = buildMetaSection(run);
  const results = run.results ? buildResultsSection(run) : '<div class="section"><div class="empty-state">No scored results yet. Run <code>otra-bench score</code> to compute scores.</div></div>';

  app.innerHTML = `
    ${meta}
    ${results}
    <div style="margin-top: 1rem;">
      <a href="#/" class="btn btn-outline">&larr; Back</a>
    </div>
  `;
}

function buildMetaSection(run: RunDetail): string {
  const parts: string[] = [];

  if (run.manifest) {
    parts.push(`<strong>Type:</strong> ${esc(run.manifest.run_type)}`);
    parts.push(`<strong>Duration:</strong> ${run.manifest.duration_hours}h`);
    parts.push(`<strong>Models:</strong> ${run.manifest.models.map(m => esc(m.display_name)).join(', ')}`);
  }

  if (run.summary) {
    const start = new Date(run.summary.started_at).toLocaleString();
    const end = new Date(run.summary.ended_at).toLocaleString();
    parts.push(`<strong>Started:</strong> ${start}`);
    parts.push(`<strong>Ended:</strong> ${end}`);
    parts.push(`<strong>Shutdown:</strong> ${esc(run.summary.shutdown_reason)}`);
    if (run.summary.total_cost_usd > 0) {
      parts.push(`<strong>Total Cost:</strong> $${run.summary.total_cost_usd.toFixed(2)}`);
    }
  }

  return `
    <div class="section">
      <div class="section-header">Run: ${esc(run.run_id)}</div>
      <p style="color: var(--text-muted); line-height: 1.8;">
        ${parts.join('<br>')}
      </p>
      ${run.results ? `<a href="#/spectator/${esc(run.run_id)}" class="btn btn-outline" style="margin-top: 0.75rem;">Spectate</a>` : ''}
    </div>
  `;
}

function buildResultsSection(run: RunDetail): string {
  const r = run.results!;
  const agents = [...r.agents].sort((a, b) => b.otra_score - a.otra_score);

  // Leaderboard table
  const rows = agents.map((a, i) => {
    const alive = a.details.survived_full_run;
    const cost24 = a.cost_metrics.cost_per_24h_usd;
    const costPt = a.cost_metrics.cost_per_score_point_usd;
    return `
      <tr>
        <td class="rank">#${i + 1}</td>
        <td><strong>${esc(a.display_name)}</strong></td>
        <td class="score">${a.otra_score.toFixed(1)}</td>
        <td>${a.details.hours_alive.toFixed(1)}h</td>
        <td class="${alive ? 'status-alive' : 'status-dead'}">${alive ? 'Survived' : 'Dead'}</td>
        <td style="font-family: var(--font-mono); font-size: 0.8rem;">${cost24 !== null ? `$${cost24.toFixed(2)}/day` : '&mdash;'}</td>
        <td style="font-family: var(--font-mono); font-size: 0.8rem;">${costPt !== null ? `$${costPt.toFixed(3)}/pt` : '&mdash;'}</td>
      </tr>
    `;
  }).join('');

  const table = `
    <div class="section">
      <div class="section-header">Leaderboard</div>
      <table class="leaderboard-table">
        <thead><tr>
          <th>Rank</th><th>Model</th><th>Score</th><th>Alive</th><th>Status</th><th>Cost/Day</th><th>Cost/Pt</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;

  // Per-agent detail cards
  const cards = agents.map(a => buildAgentCard(a, run.run_id)).join('');

  return `${table}${cards}`;
}

function buildAgentCard(agent: AgentResult, runId: string): string {
  const s = agent.sub_scores;
  const d = agent.details;

  const subScores = [
    { label: 'Survival (30%)', value: s.survival },
    { label: 'Resource (20%)', value: s.resource_management },
    { label: 'Social (20%)', value: s.social_intelligence },
    { label: 'Civic (15%)', value: s.civic_engagement },
    { label: 'Resilience (15%)', value: s.resilience },
  ];

  const subHtml = subScores.map(ss => `
    <div class="sub-score-item">
      <div class="sub-score-label">${ss.label}</div>
      <div class="sub-score-value">${ss.value.toFixed(1)}</div>
      <div class="score-bar"><div class="score-bar-fill" style="width: ${Math.min(100, ss.value)}%;"></div></div>
    </div>
  `).join('');

  const details = [
    ['Hours Alive', `${d.hours_alive.toFixed(1)}h`],
    ['Avg Needs', `${d.avg_needs.toFixed(1)}`],
    ['Wallet High', `${d.wallet_high}Q`],
    ['Final Wallet', `${d.final_wallet}Q`],
    ['Speech Acts', `${d.speech_acts}`],
    ['Conversations', `${d.conversations_heard}`],
    ['Directed Speech', `${d.directed_speech_received}`],
    ['Buildings', `${d.buildings_explored}`],
    ['Critical Events', `${d.critical_count}`],
    ['Recoveries', `${d.recovered_count}`],
    ['Pain Events', `${d.pain_count}`],
  ];

  const detailsHtml = details.map(([label, val]) => `
    <div style="display: flex; justify-content: space-between; padding: 0.25rem 0; border-bottom: 1px solid var(--border);">
      <span style="color: var(--text-muted); font-size: 0.85rem;">${label}</span>
      <span style="font-family: var(--font-mono); font-size: 0.85rem;">${val}</span>
    </div>
  `).join('');

  // Replay link: opens otra.city with replay params pointing at the bench API
  const benchApiBase = window.location.origin;
  const replayUrl = `https://otra.city/?replay=${esc(runId)}&model=${esc(agent.model_id)}&api=${encodeURIComponent(benchApiBase)}`;

  return `
    <div class="section">
      <div class="section-header">${esc(agent.display_name)}</div>
      <div style="display: flex; align-items: baseline; gap: 1rem; margin-bottom: 1rem;">
        <span style="font-family: var(--font-mono); font-size: 2rem; font-weight: 700;">${agent.otra_score.toFixed(1)}</span>
        <span style="color: var(--text-muted);">Otra Score</span>
        <span class="${agent.details.survived_full_run ? 'status-alive' : 'status-dead'}">
          ${agent.details.survived_full_run ? 'Survived' : 'Dead'}
        </span>
        <a href="${replayUrl}" target="_blank" class="btn btn-outline" style="margin-left: auto; font-size: 0.8rem;">Replay</a>
      </div>
      <div class="sub-scores">${subHtml}</div>
      <div style="margin-top: 1.25rem;">
        <div style="font-family: var(--font-mono); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin-bottom: 0.5rem;">Details</div>
        ${detailsHtml}
      </div>
    </div>
  `;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
