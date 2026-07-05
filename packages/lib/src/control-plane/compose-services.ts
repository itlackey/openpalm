/**
 * Shared, typed Docker Compose `services:` parser.
 *
 * Addons (service/profile discovery) need to walk `services[].profiles` and
 * `labels`. This centralizes that walk into one place with validated,
 * normalized shapes so callers stop casting and share one definition of "a
 * compose service".
 *
 * Volume/bind-mount resolution is NOT done here: consumers that need a
 * service's real host bind-mount sources go through Docker's own
 * `compose config --format json` (see `composeConfigJson` in docker.ts), which
 * resolves `${VAR}` interpolation and short-form `source:target:mode` strings
 * correctly. This parser is used only in docker-free discovery paths (catalog
 * listing) that must run without a daemon.
 *
 * `parseComposeServices` intentionally lets a malformed-YAML parse error
 * propagate; callers wrap it in their own try/catch so each keeps its
 * existing recovery behavior (silent skip vs. logged warning).
 */
import { parse as parseYaml } from 'yaml';

/** A normalized compose service, limited to the fields callers consume. */
export interface ComposeService {
  name: string;
  profiles: string[];
  labels: Record<string, string>;
}

/**
 * Normalize a compose `labels:` value (either an array of `KEY=VALUE`
 * strings or a map) into a flat record. Mirrors Docker Compose semantics.
 */
function normalizeLabels(raw: unknown): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq < 0) continue;
      out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v == null) continue;
      out[k] = String(v);
    }
  }
  return out;
}

/**
 * Parse a compose document's `services:` into typed, normalized services.
 *
 * Returns `[]` when there is no `services` map. Throws only if the YAML
 * itself is malformed (the `yaml` parser throws) — callers decide how to
 * recover.
 */
export function parseComposeServices(yaml: string): ComposeService[] {
  const doc = parseYaml(yaml);
  if (!doc || typeof doc !== 'object') return [];
  const services = (doc as { services?: unknown }).services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) return [];

  const out: ComposeService[] = [];
  for (const [name, raw] of Object.entries(services as Record<string, unknown>)) {
    const service: ComposeService = { name, profiles: [], labels: {} };
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.profiles)) {
        service.profiles = obj.profiles.filter((p): p is string => typeof p === 'string');
      }
      service.labels = normalizeLabels(obj.labels);
    }
    out.push(service);
  }
  return out;
}
