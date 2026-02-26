const MAX_BUCKETS = 10_000;

type Bucket = {
  timestamps: number[];
  lastSeen: number;
};

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  allow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const cutoff = now - windowMs;
    const bucket = this.buckets.get(key) ?? { timestamps: [], lastSeen: now };

    while (bucket.timestamps.length > 0 && bucket.timestamps[0] <= cutoff) {
      bucket.timestamps.shift();
    }

    if (bucket.timestamps.length >= limit) {
      bucket.lastSeen = now;
      this.buckets.set(key, bucket);
      this.evictIfNeeded(now, windowMs);
      return false;
    }

    bucket.timestamps.push(now);
    bucket.lastSeen = now;
    this.buckets.set(key, bucket);
    this.evictIfNeeded(now, windowMs);
    return true;
  }

  private evictIfNeeded(now: number, windowMs: number): void {
    if (this.buckets.size <= MAX_BUCKETS) return;
    const staleCutoff = now - windowMs;

    for (const [key, bucket] of this.buckets) {
      if (bucket.lastSeen <= staleCutoff) {
        this.buckets.delete(key);
      }
    }

    if (this.buckets.size <= MAX_BUCKETS) return;
    const overflow = this.buckets.size - MAX_BUCKETS;
    const oldest = [...this.buckets.entries()]
      .sort((a, b) => a[1].lastSeen - b[1].lastSeen)
      .slice(0, overflow);
    for (const [key] of oldest) this.buckets.delete(key);
  }
}
