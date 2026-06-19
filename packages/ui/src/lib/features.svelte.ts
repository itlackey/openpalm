import type { FeatureFlags } from '$lib/types.js';

/**
 * Client-side reactive feature flag state.
 * Initialized from layout server data (which reads env vars) so flags are
 * available on both first render (SSR) and all subsequent navigations.
 */
class FeaturesService {
  admin = $state(false);

  init(flags: FeatureFlags): void {
    this.admin = flags.admin;
  }
}

export const featuresService = new FeaturesService();
