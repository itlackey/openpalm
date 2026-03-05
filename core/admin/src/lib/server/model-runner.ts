/**
 * Local provider detection for OpenPalm.
 *
 * Probes well-known endpoints for Docker Model Runner, Ollama, and LM Studio.
 * All local providers expose OpenAI-compatible APIs and are configured through
 * the same unified provider flow as cloud providers.
 */
import { createLogger } from "./logger.js";

const logger = createLogger("local-providers");

// ── Types ────────────────────────────────────────────────────────────────

export type LocalProviderDetection = {
  provider: string;
  url: string;
  available: boolean;
};

// ── Probe Configuration ──────────────────────────────────────────────────

const LOCAL_PROVIDER_PROBES: { provider: string; probes: { url: string; baseUrl: string }[] }[] = [
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
        url: "http://host.docker.internal:11434/api/tags",
        baseUrl: "http://host.docker.internal:11434",
      },
      {
        url: "http://localhost:11434/api/tags",
        baseUrl: "http://localhost:11434",
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
      for (const { url: probeUrl, baseUrl } of probes) {
        try {
          const res = await fetch(probeUrl, {
            signal: AbortSignal.timeout(3000),
          });
          if (res.ok) {
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
