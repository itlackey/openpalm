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
 *  1. cloud provider connected      -> use it.
 *  2. host-local provider running   -> add it, proceed.
 *  3. capable GPU (>= threshold)    -> enable in-stack Ollama.
 *  4. otherwise                     -> ask the user to connect a provider.
 */
export function recommendSetup(input: SetupRecommendationInput): SetupRecommendation {
  const { cloudProviders, hostProviders, gpu } = input;

  if (cloudProviders.length > 0) {
    return { action: "use-cloud", cloudProviders };
  }

  if (hostProviders.length > 0) {
    return {
      action: "use-host-providers",
      hostProviders,
      alert: `No cloud AI provider was detected, but ${labelHostProviders(hostProviders)} ${
        hostProviders.length > 1 ? "are" : "is"
      } running on your computer — added automatically. Pick your models on the next step.`,
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
      "Connect a provider to continue — sign in to a provider on the next step, or add a custom OpenAI-compatible endpoint and key.",
  };
}
