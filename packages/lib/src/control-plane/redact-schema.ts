/**
 * Auto-generates a `redact.env.schema` from the canonical secret mappings.
 *
 * This ensures that every env var carrying a secret is marked for redaction
 * by varlock, without requiring manual maintenance of the schema file.
 */
import { getCoreSecretMappings } from './secret-mappings.js';

/**
 * Generate a redact.env.schema string from the canonical secret mappings.
 *
 * @param systemEnv - The current system env (used to discover dynamic channel secrets)
 * @returns A complete `@env-spec` schema suitable for varlock redaction
 */
export function generateRedactSchema(systemEnv: Record<string, string>): string {
  const lines: string[] = [
    '# OpenPalm — Runtime Redaction Schema (auto-generated)',
    '# Marks env vars as @sensitive so varlock redacts their values from',
    '# stdout/stderr before they reach docker compose logs.',
    '#',
    '# @defaultSensitive=true',
    '# @defaultRequired=false',
    '# ---',
    '',
  ];

  const envKeys = new Set<string>();
  for (const mapping of getCoreSecretMappings(systemEnv)) {
    envKeys.add(mapping.envKey);
  }

  // Include container-runtime env names that differ from env-file keys
  // (compose maps OP_MEMORY_TOKEN -> MEMORY_AUTH_TOKEN, etc.)
  envKeys.add('ADMIN_TOKEN');
  envKeys.add('MEMORY_AUTH_TOKEN');
  envKeys.add('OPENCODE_SERVER_PASSWORD');

  // Resolved capability API keys (written to stack.env by spec-to-env)
  envKeys.add('OP_CAP_LLM_API_KEY');
  envKeys.add('OP_CAP_EMBEDDINGS_API_KEY');
  envKeys.add('OP_CAP_TTS_API_KEY');
  envKeys.add('OP_CAP_STT_API_KEY');
  envKeys.add('OP_CAP_SLM_API_KEY');

  for (const key of [...envKeys].sort()) {
    lines.push(`${key}=`);
  }

  return lines.join('\n') + '\n';
}
