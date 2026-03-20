/**
 * Generates pass-backed `.env.schema` files for the varlock read path.
 *
 * When the pass backend is active, containers can resolve secrets at boot
 * time via `varlock run` using `pass()` resolvers instead of env_file mounts.
 */
import type { SecretScope } from './secret-mappings.js';
import { getCoreSecretMappings } from './secret-mappings.js';

type SchemaMapping = {
  envKey: string;
  secretKey: string;
  scope: SecretScope;
};

/**
 * Generate a pass-backed `@env-spec` schema for a given scope.
 *
 * @param systemEnv  - Current system env (for dynamic channel secret discovery)
 * @param scope      - Which scope to generate for ('user' or 'system')
 * @param passPrefix - The pass store prefix (e.g. 'openpalm')
 * @param storePath  - Absolute path to the PASSWORD_STORE_DIR
 * @returns A schema string with `pass()` resolvers for each sensitive env var
 */
export function generatePassSchema(
  systemEnv: Record<string, string>,
  scope: SecretScope,
  passPrefix: string,
  storePath: string,
): string {
  const mappings: SchemaMapping[] = getCoreSecretMappings(systemEnv)
    .filter((m) => m.scope === scope)
    .map((m) => ({ envKey: m.envKey, secretKey: m.secretKey, scope: m.scope }));

  const header = [
    `# OpenPalm — Pass-backed ${scope} secrets (auto-generated)`,
    '#',
    '# @defaultSensitive=true',
    '# @defaultRequired=false',
    `# @plugin(@varlock/pass-plugin)`,
    `# @initPass(storePath=${storePath}, namePrefix=${passPrefix})`,
    '# ---',
    '',
  ];

  const lines: string[] = [];
  for (const m of mappings.sort((a, b) => a.envKey.localeCompare(b.envKey))) {
    const passEntry = passPrefix ? `${passPrefix}/${m.secretKey}` : m.secretKey;
    lines.push(`${m.envKey}=pass("${passEntry}")`);
  }

  return [...header, ...lines, ''].join('\n');
}
