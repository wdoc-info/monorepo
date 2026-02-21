export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetAt: number;
};

type Entry = {
  timestamps: number[];
};

export class SimpleRateLimiter {
  private windowMs: number;
  private max: number;
  private entries = new Map<string, Entry>();

  constructor(windowMs: number, max: number) {
    this.windowMs = windowMs;
    this.max = max;
  }

  check(key: string, now: number): RateLimitResult {
    const entry = this.entries.get(key) ?? { timestamps: [] };
    const windowStart = now - this.windowMs;
    entry.timestamps = entry.timestamps.filter((timestamp) => timestamp >= windowStart);
    const allowed = entry.timestamps.length < this.max;
    if (allowed) {
      entry.timestamps.push(now);
    }
    this.entries.set(key, entry);
    return {
      allowed,
      remaining: Math.max(0, this.max - entry.timestamps.length),
      resetAt: entry.timestamps[0] ? entry.timestamps[0] + this.windowMs : now + this.windowMs,
    };
  }
}
