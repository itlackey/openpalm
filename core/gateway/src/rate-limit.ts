const buckets = new Map<string, { count: number; windowStart: number }>();

const MAX_BUCKETS = 10_000;

export function allowRequest(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || now - current.windowStart > windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
  } else if (current.count >= limit) {
    return false;
  } else {
    current.count += 1;
    buckets.set(key, current);
  }

  // Evict expired entries when the map exceeds the maximum size.
  if (buckets.size > MAX_BUCKETS) {
    for (const [k, v] of buckets) {
      if (now - v.windowStart > windowMs) buckets.delete(k);
    }
  }

  return true;
}
