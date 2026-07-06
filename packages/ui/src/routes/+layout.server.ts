import type { LayoutServerLoad } from './$types';
import { computeServerRuntimeContext } from '$lib/server/features.js';

export const load: LayoutServerLoad = (event) => {
  return {
    serverRuntimeContext: computeServerRuntimeContext(event),
  };
};
