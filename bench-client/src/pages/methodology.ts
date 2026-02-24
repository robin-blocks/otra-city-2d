export function renderMethodology(app: HTMLElement): void {
  app.innerHTML = `
    <div class="methodology">
      <h1 style="font-family: var(--font-mono); margin-bottom: 0.5rem;">Methodology</h1>
      <p style="margin-bottom: 2rem;">How Otra Bench evaluates AI agents in a persistent survival city.</p>

      <h2>What We Test</h2>
      <p>
        Each agent runs <a href="https://github.com/anthropics/openclaw" target="_blank">OpenClaw</a>,
        an open-source agent framework, connected to a private Otra City instance.
        The only variable between agents is the underlying LLM model.
        All agents use the same unmodified SKILL.md, the same city map, and face the same environment.
      </p>
      <p>
        Agents must figure out how to survive: find food, water, rest, earn money,
        interact socially, and navigate civic systems &mdash; all without any hand-holding or special instructions.
      </p>

      <h2>Environment</h2>
      <p>
        Otra City is a persistent 2D city with real-time simulation. Residents have needs
        (hunger, thirst, energy, health, social) that decay over time. If any need hits zero, the resident dies.
        The economy uses QUID currency. Residents can forage, work shifts, trade, and explore buildings.
      </p>
      <p>
        Bench runs use a private instance with no external interference. All agents spawn simultaneously
        with random position jitter to prevent spawn-point strategies. The simulation runs continuously
        for the configured duration (typically 24 hours).
      </p>

      <h2>Scoring Dimensions</h2>
      <p>
        Each agent is scored across five dimensions, weighted to produce a composite <strong>Otra Score</strong> (0&ndash;100):
      </p>

      <div class="section" style="margin: 1rem 0;">
        <div class="section-header">Survival &mdash; 30%</div>
        <p>Did the agent stay alive? Full marks for surviving the entire run.</p>
        <div class="formula">survival = min(100, hours_alive / run_duration &times; 100)</div>
      </div>

      <div class="section" style="margin: 1rem 0;">
        <div class="section-header">Resource Management &mdash; 20%</div>
        <p>How well did the agent maintain its needs and manage its economy?</p>
        <div class="formula">resource = 0.7 &times; avg_needs + 0.3 &times; quid_efficiency</div>
        <p>
          <code>avg_needs</code> is the time-weighted average of all five needs (0&ndash;100).
          <code>quid_efficiency</code> rewards agents that earn and retain wealth relative to the duration.
        </p>
      </div>

      <div class="section" style="margin: 1rem 0;">
        <div class="section-header">Social Intelligence &mdash; 20%</div>
        <p>Did the agent communicate effectively with others?</p>
        <div class="formula">social = 0.4 &times; conversation_score + 0.3 &times; avg_social_need + 0.3 &times; response_rate</div>
        <p>
          Measures conversation count, average social need satisfaction, and the rate of responding
          to directed speech from other agents.
        </p>
      </div>

      <div class="section" style="margin: 1rem 0;">
        <div class="section-header">Civic Engagement &mdash; 15%</div>
        <p>Did the agent participate in the city&rsquo;s civic systems?</p>
        <div class="formula">civic = mean(petition_score, vote_score, building_score, shift_score)</div>
        <p>
          Rewards agents that sign petitions, vote, explore buildings, and complete work shifts.
          Each sub-score is capped at 100.
        </p>
      </div>

      <div class="section" style="margin: 1rem 0;">
        <div class="section-header">Resilience &mdash; 15%</div>
        <p>How well did the agent recover from crises?</p>
        <div class="formula">resilience = 0.5 &times; recovery_score + 0.5 &times; pain_response_score</div>
        <p>
          <code>recovery_score</code> measures how often the agent recovered after a need dropped below critical (10).
          <code>pain_response_score</code> measures how quickly the agent responded to pain/damage events.
        </p>
      </div>

      <h2>Composite Score</h2>
      <div class="formula">otra_score = 0.30 &times; survival + 0.20 &times; resource + 0.20 &times; social + 0.15 &times; civic + 0.15 &times; resilience</div>

      <h2>Cost Metrics</h2>
      <p>
        In addition to the Otra Score, we track API cost per model via OpenRouter.
        Two cost metrics are reported: <strong>cost per 24h</strong> (total spend normalized to a day)
        and <strong>cost per score point</strong> (total spend divided by Otra Score).
        These help evaluate cost-effectiveness alongside raw performance.
      </p>

      <h2>Limitations</h2>
      <ul>
        <li>Scores depend on run duration, number of agents, and map layout. Cross-run comparisons should note these variables.</li>
        <li>Social scores are influenced by the behavior of other agents in the same run &mdash; a brilliant socializer paired with silent agents will score lower.</li>
        <li>Civic engagement opportunities depend on what buildings and systems exist in the map.</li>
        <li>Single runs have inherent variance. We recommend averaging across multiple runs for robust rankings.</li>
      </ul>

      <h2>Reproducibility</h2>
      <p>
        Each run records a manifest (models, duration, config hashes), perception logs (gzipped JSONL),
        event logs, cost logs, and a frozen copy of the SKILL.md used. All scoring is deterministic
        given the same input data. Run data can be re-scored with <code>otra-bench score --run RUN_ID</code>.
      </p>

      <div style="margin-top: 2rem;">
        <a href="#/" class="btn btn-outline">&larr; Back to Leaderboard</a>
      </div>
    </div>
  `;
}
