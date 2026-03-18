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

const LOCAL_PROVIDER_PROBES: { provider: string; probes: ProviderProbe[] }[] = [
  {
    provider: "model-runner",
    probes: [
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
    ],
  },
  {
    provider: "ollama",
    probes: [
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
    ],
  },
  {
    provider: "lmstudio",
    probes: [
      {
        url: "http://host.docker.internal:1234/v1/models",
        baseUrl: "http://host.docker.internal:1234",
      },
      {
        url: "http://localhost:1234/v1/models",
        baseUrl: "http://localhost:1234",
      },
    ],
  },
];

// ── Detection ────────────────────────────────────────────────────────────

/**
 * Detect all available local providers by probing well-known endpoints.
 * Returns results for all providers (available or not) in parallel.
 */
export async function detectLocalProviders(): Promise<LocalProviderDetection[]> {
  const results = await Promise.all(
    LOCAL_PROVIDER_PROBES.map(async ({ provider, probes }) => {
      for (const { url: probeUrl, baseUrl, validate } of probes) {
        try {
          const res = await fetch(probeUrl, {
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
            if (validate && !(await validate(res))) {
              logger.debug("provider probe response failed validation", { provider, url: baseUrl });
              continue;
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
