import {
  buildServedUiRuntimeConfig,
  legacyKnowledgeStackEnvFile,
  legacyStateEnvFile,
  parseEnvFile,
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
 *
 * Goes through `runHomeMigrations` rather than calling the port migration
 * directly: the migrations are gated on the recorded OP_HOME schema version, so
 * an already-migrated home does nothing here, and a home that still needs the
 * env-file consolidation gets that too — calling the port migration alone would
 * target a file the consolidation has since removed.
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
  if (!env.OP_ASSISTANT_PORT || env.OP_ASSISTANT_PORT === '3800') {
    env.OP_ASSISTANT_PORT = migrated.OP_ASSISTANT_PORT;
  }
  if (!env.OP_UI_PORT || env.OP_UI_PORT === '3810') {
    env.OP_UI_PORT = migrated.OP_UI_PORT;
  }
  if (
    env.OP_UI_SUPERVISOR === 'electron'
    && repairedDefaults
    && isRetiredGeneratedAssistantUrl(env.OP_OPENCODE_URL, env.OP_ASSISTANT_BIND_ADDRESS)
  ) {
    delete env.OP_OPENCODE_URL;
  }

  env[UI_RUNTIME_CONFIG_ENV] = serializeUiRuntimeConfig(buildServedUiRuntimeConfig(homeDir, env));
  return true;
}
