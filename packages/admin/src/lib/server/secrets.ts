/**
 * Secrets and connection key management — re-exported from @openpalm/lib.
 */
export {
  PLAIN_CONFIG_KEYS,
  ensureSecrets,
  updateSecretsEnv,
  readSecretsEnvFile,
  patchSecretsEnvFile,
  maskConnectionValue,
  loadSecretsEnvFile,
  ensureOpenCodeConfig,
} from "@openpalm/lib";
