import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * The same-origin path every OpenPalm UI process serves OpenCode on
 * (`packages/ui src/routes/oc/[...path]/+server.ts`). This is the seeded
 * baseUrl for the locked connection, in place of an absolute URL.
 *
 * A process writing this config cannot know the origin a browser will later
 * visit — localhost, a LAN IP, an mDNS `.local` name, a reverse-proxied HTTPS
 * origin — so it must not name one. The browser resolves `/oc` against the
 * origin it actually loaded, and the proxy makes the local hop with the
 * upstream credential attached server-side.
 *
 * The container entrypoint (`containers/assistant/entrypoint.sh start_ui`)
 * seeds the same literal through its own inline writer; the test in this
 * module's suite pins the two together.
 */
export const ASSISTANT_SAME_ORIGIN_PATH = '/oc';

function credentialFreeHttpUrl(baseUrl: string): string {
  // A root-relative path is the same-origin proxy: there is no origin to parse
  // and no userinfo to strip. Reject only what could resolve somewhere
  // unexpected — a protocol-relative `//host`, or userinfo/query/fragment.
  // Mirrors the accepting side in ui-runtime-config-schema.ts.
  if (baseUrl.startsWith('/')) {
    if (baseUrl.startsWith('//') || /[?#@]/.test(baseUrl)) {
      throw new Error('Assistant path must be a plain root-relative path.');
    }
    return baseUrl;
  }
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

/**
 * The browser-facing seed for a host-served UI (CLI app/admin or Electron) —
 * the counterpart to the container entrypoint's writer.
 *
 * Seeds {@link ASSISTANT_SAME_ORIGIN_PATH}, not an absolute URL. Host-served
 * clients run the same `/oc` route as the container, so pointing them at an
 * absolute `127.0.0.1:${OP_ASSISTANT_PORT}` would keep them making
 * cross-origin calls to OpenCode — which no longer grants any CORS origin, and
 * which needs a credential the browser must never hold.
 *
 * Note the narrowed override: only `OP_UI_DEFAULT_ASSISTANT_URL`, the one
 * variable that means "point the BROWSER somewhere else", is honored here. The
 * server-side upstream (`OP_OPENCODE_URL` / `OP_ASSISTANT_URL`, resolved by
 * `resolveAssistantEndpoint`) stays where it belongs — behind the proxy — and
 * seeding it to a browser would hand out an in-container address.
 */
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
      merged.OP_UI_DEFAULT_ASSISTANT_URL?.trim() || ASSISTANT_SAME_ORIGIN_PATH,
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
