import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ControlPlaneState } from './types.js';

export type SecretProviderConfig = {
  provider: 'plaintext' | 'pass';
  passwordStoreDir?: string;
  passPrefix?: string;
};

function providerConfigPath(state: ControlPlaneState): string {
  return `${state.dataDir}/secrets/provider.json`;
}

export function readSecretProviderConfig(state: ControlPlaneState): SecretProviderConfig | null {
  const path = providerConfigPath(state);
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as SecretProviderConfig;
    if (parsed?.provider === 'plaintext' || parsed?.provider === 'pass') {
      return parsed;
    }
  } catch {
    // ignore malformed provider config and fall back to schema detection
  }

  return null;
}

export function writeSecretProviderConfig(state: ControlPlaneState, config: SecretProviderConfig): void {
  const dir = `${state.dataDir}/secrets`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(providerConfigPath(state), JSON.stringify(config, null, 2) + '\n');
}
