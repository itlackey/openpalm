import type { LayoutServerLoad } from './$types';
import {
  computeOpencodeWorkspace,
  computeServerRuntimeContext,
  computeVoiceRuntime,
} from '$lib/server/features.js';

export const load: LayoutServerLoad = (event) => {
  const serverRuntimeContext = computeServerRuntimeContext(event);
  const voice = computeVoiceRuntime();
  const opencodeWorkspace = computeOpencodeWorkspace();
  return {
    serverRuntimeContext: {
      ...serverRuntimeContext,
      ...(voice ? { voice } : {}),
      ...(opencodeWorkspace ? { opencodeWorkspace } : {}),
    },
  };
};
