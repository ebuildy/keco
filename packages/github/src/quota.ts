/**
 * The 5000 points/hour budget is shared by the crawler and the analyzer (AGENTS.md §4.2,
 * §14). Two components spending the same quota without a contract is how crawls start
 * failing at 3am — so the split is explicit and each consumer holds its own governor.
 */
export type QuotaConsumer = 'crawler' | 'analyzer';

export class QuotaGovernor {
  private remaining = Infinity;
  private resetAt = new Date(0);

  constructor(
    private readonly consumer: QuotaConsumer,
    /** Share of the hourly budget this consumer may spend, 0..1. */
    private readonly share: number,
  ) {}

  /** Feed every response's rate-limit headers back in. Ignoring them is a failed crawl. */
  observe(headers: { remaining?: number | string; reset?: number | string }): void {
    if (headers.remaining !== undefined) this.remaining = Number(headers.remaining);
    if (headers.reset !== undefined) this.resetAt = new Date(Number(headers.reset) * 1000);
  }

  /** Points this consumer is still allowed to spend under its share of the budget. */
  get budget(): number {
    if (this.remaining === Infinity) return Infinity;
    return Math.max(0, Math.floor(this.remaining - 5000 * (1 - this.share)));
  }

  get exhausted(): boolean {
    return this.budget <= 0 && this.resetAt.getTime() > Date.now();
  }

  /** Milliseconds until the window resets. Callers sleep rather than hammering a 403. */
  get waitMs(): number {
    return Math.max(0, this.resetAt.getTime() - Date.now());
  }

  describe(): string {
    return `${this.consumer}: ${this.budget} points until ${this.resetAt.toISOString()}`;
  }
}

/** Exponential backoff for 403/429; `retry-after` always wins when the server sends one (§4.1). */
export function backoffMs(attempt: number, retryAfterSeconds?: number | null): number {
  if (retryAfterSeconds) return retryAfterSeconds * 1000;
  return Math.min(60_000, 2 ** attempt * 1000) + Math.random() * 250;
}
