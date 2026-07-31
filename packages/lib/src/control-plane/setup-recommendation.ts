// Pure decision engine for "what should setup do about AI providers?".
//
// Inputs are gathered by the caller (detected cloud providers, host-local
// providers, GPU). This module makes the call and produces a recommendation +
// user-facing alert. It is intentionally pure and free of I/O so it is trivially
// unit-testable and easy to evolve as new hardware/providers/models ship — the
// only things to edit are the constants at the top and the ordered rules in
// recommendSetup().

import type { GpuInfo, GpuVendor } from "./hardware-detect.js";

export type { GpuInfo, GpuVendor } from "./hardware-detect.js";

/** Minimum VRAM to auto-enable in-stack Ollama for local models. Edit freely. */
export const MIN_LOCAL_GPU_VRAM_MB = 8 * 1024;

/** Ollama hardware-profile variant chosen per GPU vendor. Extend per new vendor. */
const VENDOR_PROFILE_VARIANT: Record<GpuVendor, "cuda" | "rocm" | "cpu"> = {
  nvidia: "cuda",
  amd: "rocm",
  // The in-stack Ollama container on a Mac is a Linux container with no Metal
  // access, so it can only ever run CPU. (On darwin apple GPUs are routed to
  // host-Ollama guidance and never reach enable-ollama — see recommendSetup.)
  apple: "cpu",
  unknown: "cpu",
};

export function gpuToProfileVariant(gpu: GpuInfo): "cuda" | "rocm" | "cpu" {
  return VENDOR_PROFILE_VARIANT[gpu.vendor] ?? "cpu";
}

export type DetectedHostProvider = { provider: string; url: string };

export type SetupRecommendationInput = {
  /** Cloud providers already connected (api-key / oauth / env). */
  cloudProviders: string[];
  /** Local providers reachable on the host (e.g. ollama, lmstudio), available only. */
  hostProviders: DetectedHostProvider[];
  /** Best detected GPU, or null. */
  gpu: GpuInfo | null;
  /**
   * Host platform. Defaults to `process.platform` when omitted, but the decision
   * logic only reads this field (never `process.*`) so the function stays pure.
   * On darwin the in-stack Linux Ollama can't reach the Mac's Metal GPU, so an
   * apple GPU is routed to host-Ollama guidance instead of enable-ollama.
   */
  platform?: NodeJS.Platform;
  /**
   * Number of credentials found in the host user's OpenCode auth.json
   * (~/.local/share/opencode/auth.json). When > 0 the host OpenCode has
   * configured providers that should be imported rather than bypassed by
   * auto-enabling the bundled in-stack Ollama.
   *
   * Gathered by the caller via detectHostOpenCode() — kept out of this module
   * so the function stays pure and unit-testable.
   */
  hostCredentialCount?: number;
};

export type SetupRecommendation =
  // A cloud provider is connected — nothing to auto-configure; proceed normally.
  | { action: "use-cloud"; cloudProviders: string[] }
  // No cloud, but local providers are running on the host — add them and proceed
  // to model detection.
  | { action: "use-host-providers"; hostProviders: DetectedHostProvider[]; alert: string }
  // No provider at all, but a capable GPU exists — enable in-stack Ollama.
  | { action: "enable-ollama"; profileVariant: "cuda" | "rocm" | "cpu"; gpu: GpuInfo; alert: string }
  // No provider and no capable GPU — the user must connect one manually.
  | { action: "connect-manually"; alert: string };

const fmtGb = (mb: number): string => (mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1);

const labelHostProviders = (h: DetectedHostProvider[]): string =>
  h.map((p) => p.provider).join(" and ");

/**
 * Decide what setup should do, given detected providers + hardware.
 *
 * Order (first match wins):
 *  1. cloud provider connected              -> use it.
 *  2. host OpenCode has credentials         -> steer to import; NEVER auto-enable Ollama.
 *  3. host-local provider running           -> add it, proceed.
 *  4. darwin + apple GPU                    -> guide to HOST Ollama (Metal); never in-stack.
 *  5. capable GPU (>= threshold)            -> enable in-stack Ollama.
 *  6. otherwise                             -> ask the user to connect a provider.
 */
export function recommendSetup(input: SetupRecommendationInput): SetupRecommendation {
  const { cloudProviders, hostProviders, gpu } = input;
  const platform = input.platform ?? process.platform;
  const hostCredentialCount = input.hostCredentialCount ?? 0;

  if (cloudProviders.length > 0) {
    return { action: "use-cloud", cloudProviders };
  }

  // A host OpenCode installation with credentials outranks auto-enabling the
  // bundled in-stack Ollama. The user already has configured providers — they
  // should import them rather than spin up a new Ollama container. We reuse
  // the existing `connect-manually` action (already handled by the wizard's
  // Providers step) with an import-oriented alert so no new wizard branch is
  // needed. This rule runs BEFORE host-local-provider detection so that even a
  // running host Ollama does not shadow the richer "import your existing setup"
  // guidance when host credentials are present.
  if (hostCredentialCount > 0) {
    return {
      action: "connect-manually",
      alert:
        "Your host OpenCode installation has configured AI providers. " +
        "Import them now to use your existing setup — choose \"Sign in to a cloud service\" " +
        "and use the account found on this computer, or connect a provider manually.",
    };
  }

  if (hostProviders.length > 0) {
    return {
      action: "use-host-providers",
      hostProviders,
      alert: `No cloud AI provider was detected, but ${labelHostProviders(hostProviders)} ${
        hostProviders.length > 1 ? "are" : "is"
      } running on your computer — added automatically.`,
    };
  }

  // macOS: the in-stack Ollama is a Linux container with no access to the Mac's
  // Metal GPU, so enabling it would silently fall back to slow CPU. When the Mac
  // has an Apple-Silicon GPU and nothing is connected yet, steer the user to a
  // native host Ollama (which DOES use Metal) via connect-manually — reusing the
  // existing action avoids a new wizard branch (chosen for minimal UI impact).
  if (platform === "darwin" && gpu && gpu.vendor === "apple") {
    return {
      action: "connect-manually",
      alert:
        "No AI provider was detected. On macOS, fast local models need Ollama running " +
        "natively (it uses your Apple Silicon / Metal GPU) — the bundled in-stack Ollama " +
        "runs in Linux and cannot reach Metal. Install Ollama for macOS (https://ollama.com/download), " +
        "or sign in to a cloud provider instead.",
    };
  }

  if (gpu && gpu.vramMb >= MIN_LOCAL_GPU_VRAM_MB) {
    return {
      action: "enable-ollama",
      profileVariant: gpuToProfileVariant(gpu),
      gpu,
      alert: `No AI provider was detected, but a capable GPU was found (${gpu.name}, ${fmtGb(
        gpu.vramMb,
      )} GB). Local models via Ollama have been enabled for you.`,
    };
  }

  return {
    action: "connect-manually",
    alert:
      "No AI provider was detected and no GPU with enough memory for local models was found. " +
      "Sign in to a provider to continue, or add a custom OpenAI-compatible endpoint and key " +
      "from your dashboard.",
  };
}
