import type { LayoutServerLoad } from './$types';
import { computeFeatureFlags, computeServerRuntimeContext } from '$lib/server/features.js';

export const load: LayoutServerLoad = (event) => {
  return {
    // Derived alias — kept until the features.admin → hasCapability()
    // migration completes (plan ui-runtime-modes-plan.md Phase 1).
    features: computeFeatureFlags(),
    serverRuntimeContext: computeServerRuntimeContext(event),
  };
};
