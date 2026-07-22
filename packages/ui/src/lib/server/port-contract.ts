import {
  buildServedUiRuntimeConfig,
  migrateLegacyDefaultPorts,
  readStackRuntimeEnv,
  serializeUiRuntimeConfig,
  UI_RUNTIME_CONFIG_ENV,
} from '@openpalm/lib';

function isRetiredGeneratedAssistantUrl(
  value: string | undefined,
  bindAddress: string | undefined,
): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    const generatedHost = url.hostname === '127.0.0.1'
      || url.hostname === 'localhost'
      || (!!bindAddress && url.hostname === bindAddress);
    return url.protocol === 'http:'
      && url.port === '3800'
      && generatedHost
      && (url.pathname === '' || url.pathname === '/');
  } catch {
    return false;
  }
}

/**
 * Reconcile the corrected port contract in the updatable UI control plane. A
 * successful migration refreshes the process-scoped browser connection without
 * mutating the shared UI build artifact.
 */
export function reconcileSupervisedPortContract(
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!env.OP_UI_SUPERVISOR || !migrateLegacyDefaultPorts(homeDir)) return false;

  const migrated = readStackRuntimeEnv(homeDir);
  if (!env.OP_ASSISTANT_PORT || env.OP_ASSISTANT_PORT === '3800') {
    env.OP_ASSISTANT_PORT = migrated.OP_ASSISTANT_PORT;
  }
  if (!env.OP_UI_PORT || env.OP_UI_PORT === '3810') {
    env.OP_UI_PORT = migrated.OP_UI_PORT;
  }
  if (
    env.OP_UI_SUPERVISOR === 'electron'
    && migrated.OP_ASSISTANT_PORT !== '3800'
    && isRetiredGeneratedAssistantUrl(env.OP_OPENCODE_URL, env.OP_ASSISTANT_BIND_ADDRESS)
  ) {
    delete env.OP_OPENCODE_URL;
  }

  env[UI_RUNTIME_CONFIG_ENV] = serializeUiRuntimeConfig(buildServedUiRuntimeConfig(homeDir, env));
  return true;
}
