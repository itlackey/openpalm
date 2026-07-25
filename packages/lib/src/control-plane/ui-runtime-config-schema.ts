export const UI_RUNTIME_CONFIG_ENV = 'OP_UI_RUNTIME_CONFIG_JSON';

export type UiRuntimeConnection = {
  id: string;
  label: string;
  baseUrl: string;
  auth: { mode: 'none' };
  isDefault?: boolean;
  locked?: boolean;
};

export type UiRuntimeConfig = {
  connections: UiRuntimeConnection[];
};

export type UiRuntimeConfigJsonResult =
  | { status: 'absent' }
  | { status: 'invalid' }
  | { status: 'valid'; config: UiRuntimeConfig };

function parseConnection(value: unknown): UiRuntimeConnection | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== 'string'
    || !entry.id.trim()
    || typeof entry.label !== 'string'
    || !entry.label.trim()
    || typeof entry.baseUrl !== 'string'
    || !entry.auth
    || typeof entry.auth !== 'object'
    || Array.isArray(entry.auth)
    || (entry.auth as Record<string, unknown>).mode !== 'none'
    || (entry.isDefault !== undefined && typeof entry.isDefault !== 'boolean')
    || (entry.locked !== undefined && typeof entry.locked !== 'boolean')
  ) {
    return null;
  }

  // A ROOT-RELATIVE baseUrl (`/oc`) is the same-origin proxy this app serves.
  // It is accepted without URL parsing on purpose: the process writing this
  // file cannot know the origin a browser will later visit, so the browser
  // resolves it against its own origin at load time. Reject anything that
  // could resolve somewhere unexpected — a protocol-relative `//host`, or a
  // path carrying userinfo/query/fragment.
  if (entry.baseUrl.startsWith('/')) {
    if (entry.baseUrl.startsWith('//') || /[?#@]/.test(entry.baseUrl)) return null;
  } else {
    try {
      const url = new URL(entry.baseUrl);
      if (
        (url.protocol !== 'http:' && url.protocol !== 'https:')
        || url.username
        || url.password
      ) return null;
    } catch {
      return null;
    }
  }

  return {
    id: entry.id,
    label: entry.label,
    baseUrl: entry.baseUrl,
    auth: { mode: 'none' },
    ...(entry.isDefault === undefined ? {} : { isDefault: entry.isDefault }),
    ...(entry.locked === undefined ? {} : { locked: entry.locked }),
  };
}

export function parseUiRuntimeConfig(value: unknown): UiRuntimeConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const connections = (value as Record<string, unknown>).connections;
  if (!Array.isArray(connections)) return null;

  const parsed = connections.map(parseConnection);
  if (parsed.some((entry) => entry === null)) return null;
  const config = { connections: parsed as UiRuntimeConnection[] };
  if (new Set(config.connections.map((entry) => entry.id)).size !== config.connections.length) return null;
  return config;
}

export function parseUiRuntimeConfigJson(value: string | undefined): UiRuntimeConfigJsonResult {
  if (value === undefined) return { status: 'absent' };
  try {
    const config = parseUiRuntimeConfig(JSON.parse(value) as unknown);
    return config ? { status: 'valid', config } : { status: 'invalid' };
  } catch {
    return { status: 'invalid' };
  }
}

export function serializeUiRuntimeConfig(config: UiRuntimeConfig): string {
  return JSON.stringify(config);
}
