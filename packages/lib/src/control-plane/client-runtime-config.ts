import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Locked default connection id/label (review finding I5). The container
 * entrypoint (containers/assistant/entrypoint.sh) writes runtime-config.json
 * via its own inline JS and must use the SAME id/label as this lib writer —
 * exporting them as named constants lets that lane pin its literal against
 * this value instead of the two copies silently drifting. Today the two
 * writers disagree (`assistant-container-opencode` vs
 * `openpalm-assistant-opencode`); this is harmless only because they write
 * to distinct origins with per-origin IndexedDB isolation. Do not change
 * this value without also updating the entrypoint.
 */
export const ASSISTANT_LOCKED_CONNECTION_ID = 'openpalm-assistant-opencode';
export const ASSISTANT_LOCKED_CONNECTION_LABEL = 'This assistant';

export type ClientRuntimeConnection = {
  id: string;
  label: string;
  kind: 'local-opencode';
  url: string;
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

export function buildLockedAssistantRuntimeConfig(url: string): ClientRuntimeConfig {
  return {
    connections: [
      {
        id: ASSISTANT_LOCKED_CONNECTION_ID,
        label: ASSISTANT_LOCKED_CONNECTION_LABEL,
        kind: 'local-opencode',
        url,
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
 */
export function writeClientRuntimeConfig(
  path: string,
  assistantUrl: string,
  options: WriteClientRuntimeConfigOptions = {}
): void {
  mkdirSync(dirname(path), { recursive: true });
  const config: ClientRuntimeConfig = buildLockedAssistantRuntimeConfig(assistantUrl);
  if (options.hostUrl) config.hostUrl = options.hostUrl;
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
