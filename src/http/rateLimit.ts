/**
 * A sliding-window counter per key, in memory. The contract's limits are
 * small and the groups are small, so there is nothing to persist and no
 * timer to run: stale entries are dropped on the way through.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records a hit and says whether the key is still inside the limit. */
  allow(key: string, now: number): boolean {
    const floor = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > floor);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.prune(floor);
    return true;
  }

  private prune(floor: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((at) => at <= floor)) this.hits.delete(key);
    }
  }
}
