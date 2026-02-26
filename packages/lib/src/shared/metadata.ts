const MAX_DEPTH = 3;
const MAX_KEYS_PER_OBJECT = 50;
const MAX_ITEMS_PER_ARRAY = 50;
const MAX_STRING_LENGTH = 2_000;

function sanitizeScalar(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_STRING_LENGTH) return value;
    return value.slice(0, MAX_STRING_LENGTH);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  return undefined;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  const scalar = sanitizeScalar(value);
  if (scalar !== undefined) return scalar;
  if (depth >= MAX_DEPTH) return "[truncated]";

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS_PER_ARRAY).map((item) => sanitizeValue(item, depth + 1));
  }

  if (typeof value === "object" && value !== null) {
    const out = Object.create(null) as Record<string, unknown>;
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS_PER_OBJECT);
    for (const [key, child] of entries) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[key] = sanitizeValue(child, depth + 1);
    }
    return out;
  }

  return String(value);
}

export function sanitizeMetadataObject(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  return sanitizeValue(input, 0) as Record<string, unknown>;
}
