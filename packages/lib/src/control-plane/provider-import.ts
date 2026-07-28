import { hasGuardianIngressAddon } from './addon-ids.js';
import { listEnabledAddonIds } from './addons.js';
import { buildComposeOptions } from './compose-args.js';
import { checkDocker, composeRestart } from './docker.js';
import type { ControlPlaneState } from './types.js';

export type ProviderConsumerRestartResult = {
  restarted: string[];
  failed: { service: string; error: string }[];
};

export type ProviderImportChanges = {
  config: boolean;
  auth: boolean;
};

export async function restartProviderConsumers(
  state: ControlPlaneState,
  changed: ProviderImportChanges,
): Promise<ProviderConsumerRestartResult> {
  const services: string[] = [];
  if (changed.config || changed.auth) services.push('assistant');
  if (changed.auth && hasGuardianIngressAddon(listEnabledAddonIds(state.homeDir))) {
    services.push('guardian');
  }
  if (services.length === 0) return { restarted: [], failed: [] };

  const docker = await checkDocker();
  if (!docker.ok) {
    return { restarted: [], failed: services.map((service) => ({ service, error: 'docker unavailable' })) };
  }

  const opts = buildComposeOptions(state);
  const restarted: string[] = [];
  const failed: { service: string; error: string }[] = [];
  for (const service of services) {
    try {
      const result = await composeRestart([service], opts);
      if (result.ok) restarted.push(service);
      else failed.push({ service, error: result.stderr || `exit ${result.code}` });
    } catch (error) {
      failed.push({ service, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { restarted, failed };
}
