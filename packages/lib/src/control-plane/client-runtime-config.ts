import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveAssistantEndpoint } from './assistant-endpoint.js';

/**
 * Locked default connection id/label (review finding I5). The container
 * entrypoint (containers/assistant/entrypoint.sh) writes runtime-config.json
 * via its own inline JS and must use the SAME id/label as this lib writer —
 * exporting them as named constants lets that lane pin its literal against
 * this value instead of the two copies silently drifting. The two writers are
 * pinned equal: the assistant entrypoint's `start_ui` co-process writes this
 * exact `openpalm-assistant-opencode` id/label beside the served
 * `@openpalm/ui` build. Do not change this value without also updating the
 * entrypoint.
 */
export const ASSISTANT_LOCKED_CONNECTION_ID = 'openpalm-assistant-opencode';
export const ASSISTANT_LOCKED_CONNECTION_LABEL = 'This assistant';

/**
 * One connection record as seeded into the browser-owned connection store
 * (packages/ui/src/lib/connections/store.ts). The store's `Connection` shape
 * is `{ id, label, baseUrl, auth }` — the `url`/`kind` fields of the old
 * @openpalm/client store were dropped when the UI became the single surface
 * ("One UI, delete the split"): `url` → `baseUrl`, and Guardian is a
 * transparent OpenCode proxy so a connection `kind` no longer exists. The
 * locked default always ships `auth: { mode: 'none' }`; the browser can attach
 * Basic credentials to it later (store.setSecretRef → `{ mode: 'basic', … }`).
 */
export type ClientRuntimeConnection = {
  id: string;
  label: string;
  baseUrl: string;
  auth: { mode: 'none' };
  isDefault: true;
  locked: true;
};

export type ClientRuntimeConfig = {
  connections: ClientRuntimeConnection[];
  /**
   * Optional link back to the host UI (e.g. `http://127.0.0.1:3880/host`).
   * Consumed by the client SPA (A2/H4) to render a "Manage assistant" /
   * "Open OpenPalm admin" escape hatch — the client SPA otherwise has no
   * route back to setup/host/voice. Absent when the writer has no host UI
   * to point at (e.g. a container-only deployment with no host process).
   */
  hostUrl?: string;
};

export function buildLockedAssistantRuntimeConfig(baseUrl: string): ClientRuntimeConfig {
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

/** Optional extra fields {@link writeClientRuntimeConfig} can write alongside the connections. */
export type WriteClientRuntimeConfigOptions = {
  /** See {@link ClientRuntimeConfig.hostUrl}. Omitted from the JSON entirely when not set. */
  hostUrl?: string;
};

/**
 * Write runtime-config.json for the client SPA.
 *
 * Backward compatible: existing 2-arg callers (`writeClientRuntimeConfig(path,
 * assistantUrl)`) keep compiling and keep writing a file with no `hostUrl`
 * key at all. New callers (Electron/CLI, adopting A2/H4 in parallel) pass a
 * third options argument: `writeClientRuntimeConfig(path, assistantUrl, {
 * hostUrl })`.
 *
 * A `null` `assistantUrl` is the stack-less client-only serve (#486): writes
 * `connections: []` instead of the locked "This assistant" entry, so a
 * machine with no local install doesn't seed a connection pointing at a dead
 * `http://127.0.0.1:3800` (the client's landing resolver would otherwise
 * count 1 stored connection and land on `/chat` against a dead target
 * instead of `/connections/new`). The client store's `seedFromRuntimeConfig`
 * already deletes a previously seeded locked entry absent from the new
 * config, so a later `openpalm install` (or uninstall) round-trips cleanly.
 */
export function writeClientRuntimeConfig(
  path: string,
  assistantUrl: string | null,
  options: WriteClientRuntimeConfigOptions = {}
): void {
  mkdirSync(dirname(path), { recursive: true });
  const config: ClientRuntimeConfig =
    assistantUrl === null ? { connections: [] } : buildLockedAssistantRuntimeConfig(assistantUrl);
  if (options.hostUrl) config.hostUrl = options.hostUrl;
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
  writeClientRuntimeConfig(
    join(uiBuildDir, 'client', 'runtime-config.json'),
    resolveAssistantEndpoint(homeDir, env),
  );
}
