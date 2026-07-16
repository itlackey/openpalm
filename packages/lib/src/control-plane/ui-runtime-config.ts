import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveAssistantEndpoint } from './assistant-endpoint.js';

/**
 * Locked default connection id/label. The assistant container entrypoint
 * (containers/assistant/entrypoint.sh `start_ui`) writes runtime-config.json via
 * its own inline JS and must use the SAME id/label as this writer — exporting
 * them as named constants lets that lane pin its literal against this value so
 * the two copies can't drift. Do not change without also updating the entrypoint.
 */
export const ASSISTANT_LOCKED_CONNECTION_ID = 'openpalm-assistant-opencode';
export const ASSISTANT_LOCKED_CONNECTION_LABEL = 'This assistant';

/**
 * One connection record as seeded into the browser-owned connection store
 * (packages/ui/src/lib/connections/store.ts), shape `{ id, label, baseUrl, auth }`.
 * The locked default always ships `auth: { mode: 'none' }`; the browser can
 * attach Basic credentials later (store.setSecretRef → `{ mode: 'basic', … }`).
 */
export type UiRuntimeConnection = {
  id: string;
  label: string;
  baseUrl: string;
  auth: { mode: 'none' };
  isDefault: true;
  locked: true;
};

export type UiRuntimeConfig = {
  connections: UiRuntimeConnection[];
};

export function buildLockedAssistantRuntimeConfig(baseUrl: string): UiRuntimeConfig {
  return {
    connections: [
      {
        id: ASSISTANT_LOCKED_CONNECTION_ID,
        label: ASSISTANT_LOCKED_CONNECTION_LABEL,
        baseUrl,
        auth: { mode: 'none' },
        isDefault: true,
        locked: true,
      },
    ],
  };
}

/**
 * Write `runtime-config.json` (the browser connection store's seed) with the one
 * locked "This assistant" default connection pointing at `assistantUrl`.
 */
export function writeUiRuntimeConfig(path: string, assistantUrl: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const config = buildLockedAssistantRuntimeConfig(assistantUrl);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * Seed `runtime-config.json` for a HOST-served `@openpalm/ui` build (Electron /
 * CLI), matching what the assistant container entrypoint writes inline.
 *
 * The browser's connection store fetches `/runtime-config.json` from its own
 * origin (packages/ui connections/store.ts `loadRuntimeConfig`); adapter-node
 * serves the build's `client/` directory at the app root, so the file must land
 * at `<uiBuildDir>/client/runtime-config.json`. Without this, an Electron/CLI
 * launch opens the UI with an empty connection list instead of the locked
 * "This assistant" default.
 *
 * The connection URL comes from the ONE shared {@link resolveAssistantEndpoint}
 * precedence (so `OP_UI_DEFAULT_ASSISTANT_URL`/`OP_OPENCODE_URL`/… win), exactly
 * as the container's inline seed does. Re-callable — the host UI supervisor
 * re-seeds on every (re)spawn so a changed assistant URL is picked up, and a
 * stale locked entry is pruned by the store's `seedFromRuntimeConfig`.
 */
export function seedServedUiRuntimeConfig(
  uiBuildDir: string,
  homeDir: string,
  env: Record<string, string | undefined> = process.env,
): void {
  writeUiRuntimeConfig(
    join(uiBuildDir, 'client', 'runtime-config.json'),
    resolveAssistantEndpoint(homeDir, env),
  );
}
