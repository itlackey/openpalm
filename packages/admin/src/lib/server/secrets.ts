/**
 * Secrets and connection key management — re-exported from @openpalm/lib.
 */
export {
  ALLOWED_CONNECTION_KEYS,
  REQUIRED_LLM_PROVIDER_KEYS,
  PLAIN_CONFIG_KEYS,
  ensureSecrets,
  updateSecretsEnv,
  readSecretsEnvFile,
  patchSecretsEnvFile,
  maskConnectionValue,
  loadSecretsEnvFile,
  ensureOpenCodeConfig,
} from "@openpalm/lib";
