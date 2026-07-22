import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveAssistantEndpoint } from './assistant-endpoint.js';
import { stackDirFor } from './home.js';
import { classifyLocalInstall } from './launch-status.js';
import { readStackEnv } from './secrets.js';
import { serializeUiRuntimeConfig, type UiRuntimeConfig } from './ui-runtime-config-schema.js';

export type { UiRuntimeConfig, UiRuntimeConnection } from './ui-runtime-config-schema.js';

/**
 * Locked default connection id and fallback label. The assistant container
 * entrypoint (containers/assistant/entrypoint.sh `start_ui`) writes
 * runtime-config.json via its own inline JS and must use the SAME id/fallback
 * label as this writer — exporting them as named constants lets that lane pin
 * its literal against this value so the two copies can't drift. Do not change
 * without also updating the entrypoint.
 */
export const ASSISTANT_LOCKED_CONNECTION_ID = 'openpalm-assistant-opencode';
export const ASSISTANT_LOCKED_CONNECTION_LABEL = 'Local assistant';
export const UI_RUNTIME_CONFIG_ENDPOINT_MARKER = '.openpalm-runtime-config-endpoint-v1';

function credentialFreeHttpUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Assistant URL must use http or https.');
  }
  if (!url.username && !url.password) return baseUrl;
  url.username = '';
  url.password = '';
  return url.toString();
}

export function buildLockedAssistantRuntimeConfig(
  baseUrl: string,
  label = ASSISTANT_LOCKED_CONNECTION_LABEL,
): UiRuntimeConfig {
  return {
    connections: [
      {
        id: ASSISTANT_LOCKED_CONNECTION_ID,
        label: label.trim() || ASSISTANT_LOCKED_CONNECTION_LABEL,
        baseUrl: credentialFreeHttpUrl(baseUrl),
        auth: { mode: 'none' },
        isDefault: true,
        locked: true,
      },
    ],
  };
}

export function buildEmptyUiRuntimeConfig(): UiRuntimeConfig {
  return { connections: [] };
}

export function buildServedUiRuntimeConfig(
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): UiRuntimeConfig {
  if (classifyLocalInstall(stackDirFor(homeDir), homeDir) === 'not_installed') {
    return buildEmptyUiRuntimeConfig();
  }
  const merged = { ...readStackEnv(homeDir), ...env };
  try {
    return buildLockedAssistantRuntimeConfig(
      resolveAssistantEndpoint(homeDir, env),
      merged.OP_PROJECT_NAME,
    );
  } catch {
    return buildEmptyUiRuntimeConfig();
  }
}

export function uiBuildSupportsProcessRuntimeConfig(uiBuildDir: string): boolean {
  return existsSync(join(uiBuildDir, UI_RUNTIME_CONFIG_ENDPOINT_MARKER));
}

/** Keep a new supervisor compatible with an older UI artifact after a nonfatal update failure. */
export function writeLegacyServedUiRuntimeConfig(
  uiBuildDir: string,
  config: UiRuntimeConfig,
): void {
  try {
    const clientDir = join(uiBuildDir, 'client');
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(
      join(clientDir, 'runtime-config.json'),
      `${serializeUiRuntimeConfig(config)}\n`,
    );
  } catch {
    // Compatibility seeding must not prevent an otherwise usable retained UI from starting.
  }
}

export function seedLegacyServedUiRuntimeConfig(
  uiBuildDir: string,
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (uiBuildSupportsProcessRuntimeConfig(uiBuildDir)) return;
  writeLegacyServedUiRuntimeConfig(uiBuildDir, buildServedUiRuntimeConfig(homeDir, env));
}
