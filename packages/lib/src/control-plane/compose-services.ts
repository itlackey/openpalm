/**
 * Shared, typed Docker Compose `services:` parser.
 *
 * Both config-persistence (bind-mount pre-creation) and addons
 * (service/profile discovery) need to walk `services[].volumes[]`,
 * `profiles`, and `labels`. Each previously hand-rolled its own
 * `parseYaml(...) as Record<string, unknown>` deep-cast walk. This
 * centralizes that walk into one place with validated, normalized shapes so
 * callers stop casting and share one definition of "a compose service".
 *
 * `parseComposeServices` intentionally lets a malformed-YAML parse error
 * propagate; callers wrap it in their own try/catch so each keeps its
 * existing recovery behavior (silent skip vs. logged warning).
 */
import { parse as parseYaml } from 'yaml';

/** A single normalized volume / bind-mount entry from a service. */
export interface ComposeVolumeMount {
  /**
   * Host-side source. For short-form (`source:target:mode`) this is the
   * pre-`:` segment; for long-form it is the `source:` value. Empty string
   * when absent (e.g. anonymous volumes).
   */
  source: string;
  /** Container-side target path, when determinable. */
  target?: string;
  /**
   * Long-form mount `type` (`bind` | `volume` | `tmpfs` | …). `undefined`
   * for short-form string entries, which carry no explicit type.
   */
  type?: string;
  /** Long-form `bind:` options, when present. */
  bind?: { createHostPath?: boolean };
}

/** A normalized compose service, limited to the fields callers consume. */
export interface ComposeService {
  name: string;
  profiles: string[];
  labels: Record<string, string>;
  volumes: ComposeVolumeMount[];
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

/** Normalize one entry of a service's `volumes:` list. */
function normalizeVolume(raw: unknown): ComposeVolumeMount | null {
  if (typeof raw === 'string') {
    const parts = raw.split(':');
    const mount: ComposeVolumeMount = { source: parts[0] ?? '' };
    if (parts[1]) mount.target = parts[1];
    return mount;
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const mount: ComposeVolumeMount = {
      source: obj.source == null ? '' : String(obj.source),
    };
    if (typeof obj.target === 'string') mount.target = obj.target;
    if (typeof obj.type === 'string') mount.type = obj.type;
    if (obj.bind && typeof obj.bind === 'object') {
      const createHostPath = (obj.bind as Record<string, unknown>).create_host_path;
      mount.bind = { createHostPath: createHostPath === true || createHostPath === 'true' };
    }
    return mount;
  }
  return null;
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
    const service: ComposeService = { name, profiles: [], labels: {}, volumes: [] };
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.profiles)) {
        service.profiles = obj.profiles.filter((p): p is string => typeof p === 'string');
      }
      service.labels = normalizeLabels(obj.labels);
      if (Array.isArray(obj.volumes)) {
        for (const entry of obj.volumes) {
          const mount = normalizeVolume(entry);
          if (mount) service.volumes.push(mount);
        }
      }
    }
    out.push(service);
  }
  return out;
}
