import type { LayoutServerLoad } from './$types';
import { computeServerRuntimeContext, computeVoiceRuntime } from '$lib/server/features.js';

export const load: LayoutServerLoad = (event) => {
  const serverRuntimeContext = computeServerRuntimeContext(event);
  const voice = computeVoiceRuntime();
  return {
    serverRuntimeContext: {
      ...serverRuntimeContext,
      ...(voice ? { voice } : {}),
    },
  };
};
