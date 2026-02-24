import { createWriteStream, mkdirSync, type WriteStream } from 'fs';
import { join } from 'path';

export interface CostEntry {
  timestamp: number;
  model_id: string;
  cost_usd: number;
  cumulative_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

export interface CostSnapshot {
  total_cost_usd: number;
  per_model: Map<string, number>;
  budget_percent: number;
}

export class CostMonitor {
  private costLog: WriteStream | null = null;
  private perModelCost = new Map<string, number>();
  private totalCost = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private apiKey: string;
  private spendingLimit: number;
  private perModelLimit: number;
  private onBudgetWarning?: (snapshot: CostSnapshot) => void;
  private onBudgetExceeded?: (snapshot: CostSnapshot) => void;

  constructor(opts: {
    apiKey: string;
    spendingLimit: number;
    perModelLimit: number;
    dataDir: string;
    onBudgetWarning?: (snapshot: CostSnapshot) => void;
    onBudgetExceeded?: (snapshot: CostSnapshot) => void;
  }) {
    this.apiKey = opts.apiKey;
    this.spendingLimit = opts.spendingLimit;
    this.perModelLimit = opts.perModelLimit;
    this.onBudgetWarning = opts.onBudgetWarning;
    this.onBudgetExceeded = opts.onBudgetExceeded;

    mkdirSync(opts.dataDir, { recursive: true });
    this.costLog = createWriteStream(join(opts.dataDir, 'cost_log.jsonl'), { flags: 'a' });
  }

  start(pollIntervalMs: number = 60_000): void {
    console.log(`[CostMonitor] Starting (poll every ${pollIntervalMs / 1000}s, limit $${this.spendingLimit})`);
    this.poll(); // Initial check
    this.pollTimer = setInterval(() => this.poll(), pollIntervalMs);
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.costLog?.end();
    console.log(`[CostMonitor] Stopped. Total spend: $${this.totalCost.toFixed(4)}`);
  }

  private async poll(): Promise<void> {
    try {
      // OpenRouter activity API — get recent generations
      const res = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });

      if (!res.ok) {
        console.error(`[CostMonitor] OpenRouter API error: ${res.status}`);
        return;
      }

      const data = await res.json() as {
        data?: {
          usage?: number;  // total credits used in USD
          limit?: number | null;
        };
      };

      if (data.data?.usage !== undefined) {
        const newTotal = data.data.usage;
        if (newTotal > this.totalCost) {
          this.totalCost = newTotal;
          this.logCost();
        }
      }

      // Check budget
      const snapshot = this.getSnapshot();
      if (snapshot.budget_percent >= 95) {
        this.onBudgetExceeded?.(snapshot);
      } else if (snapshot.budget_percent >= 80) {
        this.onBudgetWarning?.(snapshot);
      }
    } catch (err) {
      console.error(`[CostMonitor] Poll error:`, err instanceof Error ? err.message : err);
    }
  }

  private logCost(): void {
    const entry = {
      timestamp: Date.now(),
      total_cost_usd: this.totalCost,
      spending_limit_usd: this.spendingLimit,
      budget_percent: Math.round((this.totalCost / this.spendingLimit) * 100),
    };
    this.costLog?.write(JSON.stringify(entry) + '\n');
    console.log(`[CostMonitor] Total: $${this.totalCost.toFixed(4)} (${entry.budget_percent}% of limit)`);
  }

  getSnapshot(): CostSnapshot {
    return {
      total_cost_usd: this.totalCost,
      per_model: new Map(this.perModelCost),
      budget_percent: (this.totalCost / this.spendingLimit) * 100,
    };
  }

  getTotalCost(): number {
    return this.totalCost;
  }
}
