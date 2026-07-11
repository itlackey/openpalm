/**
 * P5b (#555) — test-side contract for the @openpalm/client public surface.
 *
 * These types are the tests' statement of the API defined by
 * docs/technical/ui-runtime-modes-plan.md (§4.3 note, §6.5, §6.6, §6.11) and
 * the P5b phase spec:
 *
 *   - src/lib/transport/index.ts   ONE transport: talk to an OpenCode/guardian
 *     base URL with optional Basic/Bearer credentials — direct fetch from the
 *     browser, no proxy, NO COOKIES (`credentials: 'omit'`). Ports the minimal
 *     chat surface from packages/ui (session list/create, message send, SSE
 *     stream parsing, health probe) — see packages/ui/src/lib/api/chat.ts,
 *     packages/ui/src/lib/chat/session-events.ts and the status mapping in
 *     packages/ui/src/lib/server/endpoints.ts probeEndpoint().
 *   - src/lib/connections/index.ts ConnectionEntry store (plan §6.6) behind a
 *     storage abstraction: IndexedDB in the browser, in-memory backend for
 *     tests. Locked/default entries are seeded from a runtime-config.json
 *     fetched from the app's own origin at boot (absent file = no default).
 *   - src/lib/resolve-landing.ts   landing choice for the client app: no
 *     stored connections -> /connections/new, else /chat (plan §6.5).
 *
 * The production modules DO NOT EXIST YET. Every loader below dynamically
 * imports the module-under-test, so until the P5b implementation lands each
 * test fails with "Cannot find module …/src/lib/…" — red for the right
 * reason (missing feature). Once the modules exist the loaders bind to the
 * real exports and the assertions become the contract.
 *
 * Deliberate contract decisions encoded here (implementer: these are pinned
 * by the tests, change them only by changing the tests):
 *   - Basic auth username defaults to 'openpalm' when the connection carries
 *     only a password — mirrors the host app's probeEndpoint() default so a
 *     guardian provisioned by the host accepts the same credentials.
 *   - Health probe states are 'accessible' | 'unauthorized' | 'unreachable',
 *     the same vocabulary as the host app's RemoteStatus.
 *   - The store API is async throughout (IndexedDB is async); the in-memory
 *     backend must behave identically so tests are the spec for both.
 */

export type ConnectionKind = 'local-opencode' | 'remote-opencode' | 'openpalm-client-api';

/** Credentials handed to the transport (client-held, per connection). */
export type ConnectionAuth =
  | { mode: 'none' }
  | { mode: 'basic'; username?: string; password: string }
  | { mode: 'bearer'; token: string };

export type SessionSummary = {
  id: string;
  /** '' until OpenCode summarizes (UI renders a fallback). */
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type HealthProbeResult = {
  state: 'accessible' | 'unauthorized' | 'unreachable';
  detail?: string;
};

export type TransportOptions = {
  baseUrl: string;
  /** Default: { mode: 'none' }. */
  auth?: ConnectionAuth;
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
};

export type Transport = {
  listSessions(): Promise<SessionSummary[]>;
  createSession(): Promise<{ id: string }>;
  sendMessage(sessionId: string, text: string): Promise<unknown>;
  probeHealth(): Promise<HealthProbeResult>;
};

/** One parsed SSE frame ('\n\n'-delimited; multi-line data joined with '\n'). */
export type SseFrame = { event?: string; data?: string; id?: string };

export type TransportModule = {
  createTransport(options: TransportOptions): Transport;
  /**
   * Parse a raw SSE byte stream into frames. Yields ONLY frames that carry at
   * least one of event/data/id (comment-only and retry-only frames yield
   * nothing); an unterminated trailing frame at end-of-stream is discarded
   * (SSE spec; same behavior as packages/ui session-events.ts).
   */
  parseSseStream(stream: ReadableStream<Uint8Array>): AsyncIterable<SseFrame>;
};

/** Plan §6.6 ConnectionEntry, client-side (no host:* in grantedCapabilities' type space). */
export type ConnectionEntry = {
  id: string;
  label: string;
  kind: ConnectionKind;
  url: string;
  auth: { mode: 'none' | 'basic' | 'bearer'; secretRef?: string };
  isDefault?: boolean;
  locked?: boolean;
  grantedCapabilities?: string[];
};

export type NewConnectionInput = Omit<ConnectionEntry, 'id'> & { id?: string };

/**
 * Shape of the runtime-config.json the assistant container writes beside the
 * static build (P5d). Seeded entries carry explicit stable ids so re-seeding
 * is idempotent.
 */
export type RuntimeConfig = {
  connections: ConnectionEntry[];
};

export type ConnectionStore = {
  list(): Promise<ConnectionEntry[]>;
  get(id: string): Promise<ConnectionEntry | null>;
  /** Generates an id when the input has none. */
  add(input: NewConnectionInput): Promise<ConnectionEntry>;
  /** Rejects for unknown ids and for locked entries. */
  update(id: string, patch: Partial<Omit<ConnectionEntry, 'id'>>): Promise<ConnectionEntry>;
  /** Rejects for unknown ids and for locked entries. */
  remove(id: string): Promise<void>;
  getActiveId(): Promise<string | null>;
  getActive(): Promise<ConnectionEntry | null>;
  /** Rejects for unknown ids. */
  setActive(id: string): Promise<void>;
  /**
   * Upsert the config's (locked/default) entries by id. null config = no-op.
   * A seeded isDefault entry becomes active when nothing is active yet, but
   * never steals an explicit user selection. Config wins for locked entries
   * (label/url updates apply on re-seed); user-added entries are untouched.
   */
  seedFromRuntimeConfig(config: RuntimeConfig | null): Promise<void>;
  /**
   * E6 (review 2026-07-10 §E6): attach/clear credentials on ANY entry,
   * including locked ones — bypasses ONLY the locked check, and ONLY for
   * `auth`. Rejects for unknown ids.
   */
  setSecretRef(id: string, auth: ConnectionEntry['auth']): Promise<ConnectionEntry>;
};

export type ConnectionStorage = {
  getAll(): Promise<ConnectionEntry[]>;
  get(id: string): Promise<ConnectionEntry | null>;
  put(entry: ConnectionEntry): Promise<void>;
  delete(id: string): Promise<void>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string | null): Promise<void>;
  /** E7 (review 2026-07-10 §E7): structured-clone area for the secret store's non-extractable AES-GCM key. */
  getCryptoKey(): Promise<CryptoKey | null>;
  setCryptoKey(key: CryptoKey): Promise<void>;
};

export type ConnectionsModule = {
  /** In-memory storage backend (same semantics as the IndexedDB one). */
  createMemoryStorage(): ConnectionStorage;
  createConnectionStore(options: { storage: ConnectionStorage }): ConnectionStore;
  /**
   * Fetch '/runtime-config.json' from the app's own origin. Absent (404),
   * unreachable, or malformed file -> null (no default connection; offline
   * boot must not crash).
   */
  loadRuntimeConfig(fetchImpl?: typeof globalThis.fetch): Promise<RuntimeConfig | null>;
};

export type LandingModule = {
  /** Plan §6.5 client branch: 0 connections -> /connections/new, else /chat. */
  resolveLanding(connections: ReadonlyArray<{ id: string }>): string;
};

export function loadTransportModule(): Promise<TransportModule> {
  return import('../../src/lib/transport/index.ts') as Promise<TransportModule>;
}

export function loadConnectionsModule(): Promise<ConnectionsModule> {
  return import('../../src/lib/connections/index.ts') as Promise<ConnectionsModule>;
}

export function loadLandingModule(): Promise<LandingModule> {
  return import('../../src/lib/resolve-landing.ts') as Promise<LandingModule>;
}
