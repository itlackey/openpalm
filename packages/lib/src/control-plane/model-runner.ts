/**
 * Local provider detection for OpenPalm.
 *
 * Probes well-known endpoints for Docker Model Runner, Ollama, and LM Studio.
 */
import { createLogger } from "../logger.js";

const logger = createLogger("local-providers");

// ── Types ────────────────────────────────────────────────────────────────

export type LocalProviderDetection = {
  provider: string;
  url: string;
  available: boolean;
};

// ── Probe Configuration ──────────────────────────────────────────────────

type ProviderProbe = {
  url: string;
  baseUrl: string;
  /** Optional response validator — when present, the probe only succeeds if this returns true. */
  validate?: (res: Response) => Promise<boolean>;
};

/** Ollama's root endpoint returns "Ollama is running" — use this to distinguish from other services on :11434. */
async function validateOllamaResponse(res: Response): Promise<boolean> {
  try {
    const body = await res.json();
    // Ollama /api/tags returns { models: [...] } — verify shape
    return body != null && Array.isArray(body.models);
  } catch {
    return false;
  }
}

// ── Env-based URL parsers ────────────────────────────────────────────────

/**
 * Parse an OLLAMA_HOST env value into a normalized base URL string, or null if
 * the input is absent/malformed.
 *
 * Accepted forms:
 *   - bare port:                "9999"           → "http://localhost:9999"
 *   - host:port:                "127.0.0.1:9999" → "http://127.0.0.1:9999"
 *   - full URL (http/https):    "http://h:9999"  → "http://h:9999"
 *   - bare hostname:            "localhost"       → "http://localhost:11434"  (default port)
 *
 * Returns null for empty string, non-numeric bare tokens that aren't valid
 * hostnames, and any other garbage.
 */
export function parseOllamaHostEnv(raw: string | undefined): string | null {
  if (!raw || raw.trim() === "") return null;
  const s = raw.trim();

  // Already a full URL
  if (s.startsWith("http://") || s.startsWith("https://")) {
    try {
      const u = new URL(s);
      // Must have a usable host
      if (!u.hostname) return null;
      // Return origin (scheme + host + port, no path)
      return u.origin;
    } catch {
      return null;
    }
  }

  // Bare port number e.g. "9999"
  if (/^\d+$/.test(s)) {
    const port = parseInt(s, 10);
    if (port < 1 || port > 65535) return null;
    return `http://localhost:${port}`;
  }

  // host:port e.g. "127.0.0.1:9999" or "myhost:1234"
  const colonIdx = s.lastIndexOf(":");
  if (colonIdx > 0) {
    const host = s.slice(0, colonIdx);
    const portStr = s.slice(colonIdx + 1);
    if (!/^\d+$/.test(portStr)) return null;
    const port = parseInt(portStr, 10);
    if (port < 1 || port > 65535) return null;
    // Basic hostname/IP validity — must not contain spaces or slashes
    if (/[\s/]/.test(host)) return null;
    return `http://${host}:${port}`;
  }

  // Bare hostname (no port) — use Ollama's default port
  // Accept only simple hostname-like tokens (letters, digits, hyphens, dots)
  if (/^[a-zA-Z0-9._-]+$/.test(s)) {
    return `http://${s}:11434`;
  }

  return null;
}

/**
 * Parse a bare port env value (e.g. LMSTUDIO_PORT, MODEL_RUNNER_PORT) into an
 * integer, or null if absent/malformed.
 */
function parsePortEnv(raw: string | undefined): number | null {
  if (!raw || raw.trim() === "") return null;
  const n = parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) return null;
  return n;
}

// ── Probe timeout ────────────────────────────────────────────────────────

/**
 * Probe timeout in milliseconds.
 *
 * 5 000 ms is chosen to tolerate slow/loaded machines without blocking the
 * caller for too long.  Override with OP_LOCAL_PROBE_TIMEOUT_MS (clamped to
 * a floor of 1 000 ms so the env value can't make probes never-timeout).
 */
function getProbeTimeoutMs(): number {
  const floor = 1000;
  const envRaw = process.env["OP_LOCAL_PROBE_TIMEOUT_MS"];
  if (envRaw) {
    const n = parseInt(envRaw, 10);
    if (Number.isFinite(n) && n >= floor) return n;
  }
  return 5000;
}

// ── Dynamic probe builders ───────────────────────────────────────────────

/** Build the ordered probe list for model-runner, prepending any env-configured port. */
function buildModelRunnerProbes(): ProviderProbe[] {
  const defaults: ProviderProbe[] = [
    {
      url: "http://model-runner.docker.internal/engines/v1/models",
      baseUrl: "http://model-runner.docker.internal/engines",
    },
    {
      url: "http://model-runner.docker.internal:12434/engines/v1/models",
      baseUrl: "http://model-runner.docker.internal:12434/engines",
    },
    {
      url: "http://host.docker.internal:12434/engines/v1/models",
      baseUrl: "http://host.docker.internal:12434/engines",
    },
    {
      url: "http://localhost:12434/engines/v1/models",
      baseUrl: "http://localhost:12434/engines",
    },
  ];

  const port = parsePortEnv(process.env["MODEL_RUNNER_PORT"]);
  if (port !== null) {
    return [
      {
        url: `http://localhost:${port}/engines/v1/models`,
        baseUrl: `http://localhost:${port}/engines`,
      },
      ...defaults,
    ];
  }
  return defaults;
}

/** Build the ordered probe list for ollama, prepending any env-configured endpoint. */
function buildOllamaProbes(): ProviderProbe[] {
  const defaults: ProviderProbe[] = [
    {
      // In-stack Ollama (compose service on assistant_net)
      url: "http://ollama:11434/api/tags",
      baseUrl: "http://ollama:11434",
      validate: validateOllamaResponse,
    },
    {
      url: "http://host.docker.internal:11434/api/tags",
      baseUrl: "http://host.docker.internal:11434",
      validate: validateOllamaResponse,
    },
    {
      url: "http://localhost:11434/api/tags",
      baseUrl: "http://localhost:11434",
      validate: validateOllamaResponse,
    },
  ];

  const base = parseOllamaHostEnv(process.env["OLLAMA_HOST"]);
  if (base !== null) {
    return [
      {
        url: `${base}/api/tags`,
        baseUrl: base,
        validate: validateOllamaResponse,
      },
      ...defaults,
    ];
  }
  return defaults;
}

/** Build the ordered probe list for lmstudio, prepending any env-configured port. */
function buildLmStudioProbes(): ProviderProbe[] {
  const defaults: ProviderProbe[] = [
    {
      url: "http://host.docker.internal:1234/v1/models",
      baseUrl: "http://host.docker.internal:1234",
    },
    {
      url: "http://localhost:1234/v1/models",
      baseUrl: "http://localhost:1234",
    },
  ];

  const port = parsePortEnv(process.env["LMSTUDIO_PORT"] ?? process.env["LM_STUDIO_PORT"]);
  if (port !== null) {
    return [
      {
        url: `http://localhost:${port}/v1/models`,
        baseUrl: `http://localhost:${port}`,
      },
      ...defaults,
    ];
  }
  return defaults;
}

// ── Detection ────────────────────────────────────────────────────────────

/**
 * Detect all available local providers by probing well-known endpoints.
 * Returns results for all providers (available or not) in parallel.
 */
export async function detectLocalProviders(): Promise<LocalProviderDetection[]> {
  const probeTimeoutMs = getProbeTimeoutMs();

  const providerProbes = [
    { provider: "model-runner", probes: buildModelRunnerProbes() },
    { provider: "ollama", probes: buildOllamaProbes() },
    { provider: "lmstudio", probes: buildLmStudioProbes() },
  ];

  const results = await Promise.all(
    providerProbes.map(async ({ provider, probes }) => {
      for (const { url: probeUrl, baseUrl, validate } of probes) {
        try {
          const res = await fetch(probeUrl, {
            signal: AbortSignal.timeout(probeTimeoutMs),
          });
          if (res.ok) {
            if (validate) {
              // Clone so we can read the body for debug logging without consuming it
              const resForValidate = res.clone();
              const valid = await validate(res);
              if (!valid) {
                // Read a snippet of the body to aid debugging — 500-char cap
                let bodySnippet = "(unreadable)";
                try {
                  const raw = await resForValidate.text();
                  bodySnippet = raw.slice(0, 500);
                } catch {
                  // ignore
                }
                logger.debug("provider probe response failed validation", {
                  provider,
                  url: probeUrl,
                  bodySnippet,
                });
                continue;
              }
            }
            logger.debug("detected local provider", { provider, url: baseUrl });
            return { provider, url: baseUrl, available: true };
          }
        } catch {
          // Endpoint not reachable — try next
        }
      }
      return { provider, url: "", available: false };
    })
  );
  return results;
}
