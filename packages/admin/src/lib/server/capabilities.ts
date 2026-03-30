/**
 * Shared helper for reading, modifying, and persisting capabilities in stack.yml.
 */
import {
  readStackSpec,
  writeStackSpec,
  writeCapabilityVars,
  type StackSpec,
} from '@openpalm/lib';

/**
 * Read stack.yml, apply mutations via `mutate`, then write back and regenerate
 * managed capability env files.
 *
 * Returns the updated spec on success, or throws on failure.
 */
export function updateAndPersistCapabilities(
  configDir: string,
  vaultDir: string,
  mutate: (spec: StackSpec) => void,
): StackSpec {
  const spec = readStackSpec(configDir);
  if (!spec) throw new Error('stack.yml not found or invalid');
  mutate(spec);
  writeStackSpec(configDir, spec);
  writeCapabilityVars(spec, vaultDir);
  return spec;
}
