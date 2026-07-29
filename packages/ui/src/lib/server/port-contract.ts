import {
  buildServedUiRuntimeConfig,
  legacyKnowledgeStackEnvFile,
  legacyStateEnvFile,
  parseEnvFile,
  readStackRuntimeEnv,
  serializeUiRuntimeConfig,
  UI_RUNTIME_CONFIG_ENV,
} from '@openpalm/lib';

function isGeneratedAssistantUrlForPort(
  value: string | undefined,
  bindAddress: string | undefined,
  port: string | undefined,
): boolean {
  if (!value || !port) return false;
  try {
    const url = new URL(value);
    const generatedHost = url.hostname === '127.0.0.1'
      || url.hostname === 'localhost'
      || (!!bindAddress && url.hostname === bindAddress);
    return url.protocol === 'http:'
      && url.port === port
      && generatedHost
      && (url.pathname === '' || url.pathname === '/');
  } catch {
    return false;
  }
}

/**
 * Reconcile persisted and legacy port values into the supervised UI process.
 * This is process-local: locked lifecycle paths own on-disk home migrations.
 */
export function reconcileSupervisedPortContract(
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!env.OP_UI_SUPERVISOR) return false;

  // Read legacy values without consolidating them. Consolidation is a locked
  // lifecycle migration; startup may only derive its process-local settings.
  const migrated = {
    ...parseEnvFile(legacyKnowledgeStackEnvFile(homeDir)),
    ...parseEnvFile(legacyStateEnvFile(homeDir)),
    ...readStackRuntimeEnv(homeDir),
  };
  const repairedDefaults = migrated.OP_ASSISTANT_PORT === '3800' && !migrated.OP_UI_PORT;
  if (repairedDefaults) {
    migrated.OP_ASSISTANT_PORT = '3810';
    migrated.OP_UI_PORT = '3800';
  }
  const previousAssistantPort = env.OP_ASSISTANT_PORT;
  if (migrated.OP_ASSISTANT_PORT && (!env.OP_ASSISTANT_PORT || env.OP_ASSISTANT_PORT === '3800')) {
    env.OP_ASSISTANT_PORT = migrated.OP_ASSISTANT_PORT;
  }
  if (migrated.OP_UI_PORT && (!env.OP_UI_PORT || env.OP_UI_PORT === '3810')) {
    env.OP_UI_PORT = migrated.OP_UI_PORT;
  }
  if (
    env.OP_UI_SUPERVISOR === 'electron'
    && previousAssistantPort !== env.OP_ASSISTANT_PORT
    && isGeneratedAssistantUrlForPort(
      env.OP_OPENCODE_URL,
      env.OP_ASSISTANT_BIND_ADDRESS,
      previousAssistantPort,
    )
  ) {
    delete env.OP_OPENCODE_URL;
  }

  env[UI_RUNTIME_CONFIG_ENV] = serializeUiRuntimeConfig(buildServedUiRuntimeConfig(homeDir, env));
  return true;
}
