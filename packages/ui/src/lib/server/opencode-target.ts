/**
 * The ASSISTANT's OpenCode target — the one OpenCode this UI process talks to,
 * for chat (`/oc`), config, catalog, health, and provider credentials.
 *
 * There is exactly one target, deliberately. This module used to resolve "the
 * host's own OpenCode" with a precedence — the Electron-spawned admin child
 * first, the env-derived assistant second — which conflated two servers with
 * different purposes behind one name. Under Electron with a real install, that
 * meant the browser's locked "Local assistant" connection proxied chat to the
 * admin child, whose staged HOME is deliberately created WITHOUT `auth.json`
 * (we do not want an admin agent reading the user's LLM keys), so chat on the
 * default connection could not work by construction. The same conflation sent
 * provider-config writes into a HOME the real assistant never reads and
 * reported the wrong server's health.
 *
 * Nothing in the UI wants the admin child: its only consumer was that
 * accidental precedence (the connection broker it was built to feed was
 * deleted in Phase 3b). So the resolver is now env/stack-derived, full stop.
 * Electron still spawns the child; that spawn is now unread and is removed
 * separately.
 *
 * This is deliberately small: env/stack derivation + a URL validator (for the
 * surviving pairing MINT route). No persistence, no active selection, no user
 * entries — those belong to the browser.
 */
import { getState } from './state.js';
import { readSecret, readStackEnv } from '@openpalm/lib';
import { DEFAULT_OPENCODE_USERNAME, stripTrailingNewlines } from './basic-auth.js';

export type AssistantOpencodeTarget = {
  id: string;
  label: string;
  url: string;
  username?: string;
  password?: string;
  /** Always true — kept in the shape the health route reports to clients. */
  isDefault: boolean;
};

const DEFAULT_ID = 'default';

function normalizeBrowserFacingUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === '0.0.0.0' || host === '::') {
      url.hostname = '127.0.0.1';
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return raw;
  }
}

/**
 * The assistant's OpenCode: URL and, when OpenCode is configured to require
 * it, the Basic-auth credential to reach it.
 *
 * Read fresh on every call. `OPENCODE_AUTH` and the generated key are
 * operator-changeable at runtime, and a cached credential would 401 the whole
 * UI until the process restarted.
 */
export function getAssistantOpencodeTarget(): AssistantOpencodeTarget {
  const persisted = readStackEnv(getState().homeDir);
  const url =
    process.env.OP_OPENCODE_URL ??
    process.env.OP_ASSISTANT_URL ??
    `http://127.0.0.1:${process.env.OP_ASSISTANT_PORT ?? persisted.OP_ASSISTANT_PORT ?? '3810'}`;
  // OpenCode's server default username — the shipped assistant compose never
  // overrides OPENCODE_SERVER_USERNAME, and the guardian's upstream auth sends
  // 'opencode:<password>', so default here or a correct password 401s.
  const username = process.env.OPENCODE_SERVER_USERNAME || DEFAULT_OPENCODE_USERNAME;
  // An explicit host OPENCODE_SERVER_PASSWORD always wins. Otherwise fall back
  // to the toggle-managed generated OpenCode key, but ONLY when
  // OPENCODE_AUTH is truthy (the secret file is always materialized). Read auth
  // from the same fresh sources as the URL, not frozen process.env.
  const authEnabled = /^(true|1|yes)$/i.test(
    (persisted.OPENCODE_AUTH ?? process.env.OPENCODE_AUTH ?? '').trim()
  );
  let generatedKey: string | undefined;
  if (authEnabled) {
    const raw = readSecret(getState().homeDir, 'op_opencode_password');
    generatedKey = (raw ? stripTrailingNewlines(raw) : undefined) || process.env.OP_OPENCODE_PASSWORD;
  }
  const password = process.env.OPENCODE_SERVER_PASSWORD || generatedKey || undefined;
  return {
    id: DEFAULT_ID,
    label: 'Local Assistant',
    url: normalizeBrowserFacingUrl(url),
    username,
    password,
    isDefault: true,
  };
}

// ── URL validation (surviving pairing MINT route) ────────────────────────────

export type ConnectionUrlError =
  | 'invalid_url'
  | 'invalid_scheme'
  | 'missing_host'
  | 'userinfo_not_allowed'
  | 'unexpected_query_or_fragment';

export type ConnectionUrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: ConnectionUrlError };

/**
 * Discriminated validator for a connection/guardian BASE URL. Plain HTTP is
 * allowed for any host (OpenPalm is LAN-first). A query or fragment is rejected
 * because callers concatenate API paths onto the base (`${base}/session`).
 */
export function validateConnectionUrl(input: string): ConnectionUrlValidation {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'invalid_scheme' };
  }
  if (!u.hostname) {
    return { ok: false, reason: 'missing_host' };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'userinfo_not_allowed' };
  }
  if (u.search || u.hash) {
    return { ok: false, reason: 'unexpected_query_or_fragment' };
  }
  return { ok: true, url: u.toString().replace(/\/$/, '') };
}
