import type { LayoutServerLoad } from './$types';
import { computeFeatureFlags } from '$lib/server/features.js';

export const load: LayoutServerLoad = () => {
  return {
    features: computeFeatureFlags(),
  };
};
