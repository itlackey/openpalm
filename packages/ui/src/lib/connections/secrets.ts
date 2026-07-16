/**
 * Per-connection credential material (Phase 3a — "One UI, delete the split").
 *
 * A Connection carries only `auth.secretRef` — the actual Basic password lives
 * here, in the same browser-side storage backend (IndexedDB in the browser),
 * keyed by that ref. These are CONNECTION credentials the user pasted for a
 * Guardian/OpenCode endpoint — never host credentials.
 *
 * Material is wrapped with WebCrypto AES-GCM before it ever reaches
 * `storage.setMeta`: a non-extractable key lives in the storage backend's
 * structured-clone area (`getCryptoKey`/`setCryptoKey` — plain getMeta/setMeta
 * are JSON strings and can't carry a CryptoKey), generated once per storage
 * backend and reused for every secret. This does NOT make credentials safe
 * from a same-origin attacker in the general case (a script in this origin can
 * call `resolveAuth()`/`set()` itself — the key is non-extractable, not
 * inaccessible), but it stops casual "read the DB" exfiltration and DB-only
 * backup/sync leaks.
 *
 * Existing plaintext records (written by an install from before encryption
 * shipped) are still readable — resolveAuth() falls back to a
 * plaintext JSON.parse() when the stored value isn't the encrypted envelope
 * shape — and are transparently re-encrypted in place on first read (lazy
 * migration; no separate migration step/version bump needed).
 *
 * Narrowed to the none | basic auth model (bearer/token dropped).
 */
import type { ResolvedAuth } from '../transport/direct.js';
import type { Connection, ConnectionStorage } from './store.js';

export type SecretMaterial = {
  username?: string;
  password?: string;
};

export type SecretStore = {
  set(ref: string, material: SecretMaterial): Promise<void>;
  delete(ref: string): Promise<void>;
  /**
   * Build the transport auth for a connection. Missing or unreadable secret
   * material degrades to { mode: 'none' } — the health probe then reports
   * 'unauthorized' instead of the app crashing.
   */
  resolveAuth(entry: Connection): Promise<ResolvedAuth>;
  /**
   * Rewrite ONLY the username half of stored Basic material, preserving
   * whatever password is already stored. `undefined` clears the username. No-op
   * for an unknown ref (nothing to merge into).
   */
  updateUsername(ref: string, username: string | undefined): Promise<void>;
};

const META_PREFIX = 'secret:';
const ENCRYPTED_MARKER = 2 as const;
const AES_GCM_LENGTH = 256;
const IV_BYTES = 12;

type EncryptedRecord = { v: typeof ENCRYPTED_MARKER; iv: string; ciphertext: string };

/**
 * WebCrypto's `SubtleCrypto` is secure-context-only: on a plain-http LAN origin
 * (the LAN-served tier) `crypto.subtle` is undefined, so encryption is simply
 * not available there. Callers degrade to the legacy plaintext record shape —
 * which `readMaterial` already reads — rather than throwing and blocking the
 * user from saving a credential at all.
 */
function subtleAvailable(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle;
}

function isEncryptedRecord(value: unknown): value is EncryptedRecord {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { v?: unknown }).v === ENCRYPTED_MARKER &&
    typeof (value as { iv?: unknown }).iv === 'string' &&
    typeof (value as { ciphertext?: unknown }).ciphertext === 'string'
  );
}

function bytesToBase64(bytes: Uint8Array<ArrayBuffer>): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Explicit `<ArrayBuffer>` (not the bare `Uint8Array`, which TS widens to
// `Uint8Array<ArrayBufferLike>`): SubtleCrypto's BufferSource params require an
// actual ArrayBuffer-backed view.
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Memoize the in-flight key generation per storage backend so concurrent
// first-time callers (e.g. probeAll() resolving auth for every connection in
// one Promise.all, each lazily migrating a pre-encryption plaintext record)
// resolve to ONE key instead of each generating its own and the last write
// winning — which would leave every record encrypted under a losing key
// permanently undecryptable. The get-then-set of `pendingKeys` has NO `await`
// between them, so whichever concurrent caller's continuation resumes first
// wins the memo atomically. Keyed by the storage instance (not global) so
// unrelated backends — e.g. two independent stores in tests — never share a
// key.
const pendingKeys = new WeakMap<ConnectionStorage, Promise<CryptoKey>>();

/** Generate-once, reuse-forever non-extractable AES-GCM key for this storage backend. */
async function getOrCreateKey(storage: ConnectionStorage): Promise<CryptoKey> {
  const existing = await storage.getCryptoKey();
  if (existing) return existing;
  let pending = pendingKeys.get(storage);
  if (!pending) {
    pending = (async () => {
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: AES_GCM_LENGTH }, false, [
        'encrypt',
        'decrypt',
      ]);
      await storage.setCryptoKey(key);
      return key;
    })();
    pendingKeys.set(storage, pending);
    // Evict a REJECTED generation from the memo: a memoized rejection (e.g. a
    // transient IndexedDB write failure in setCryptoKey) would otherwise be
    // handed to every later caller, permanently poisoning all secret writes
    // and encrypted reads for this backend until page reload.
    pending.catch(() => {
      pendingKeys.delete(storage);
    });
  }
  return pending;
}

async function encryptMaterial(key: CryptoKey, material: SecretMaterial): Promise<EncryptedRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(material));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  return { v: ENCRYPTED_MARKER, iv: bytesToBase64(iv), ciphertext: bytesToBase64(ciphertext) };
}

async function decryptRecord(key: CryptoKey, record: EncryptedRecord): Promise<SecretMaterial> {
  const iv = base64ToBytes(record.iv);
  const ciphertext = base64ToBytes(record.ciphertext);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext)) as SecretMaterial;
}

async function writeMaterial(storage: ConnectionStorage, ref: string, material: SecretMaterial): Promise<void> {
  if (!subtleAvailable()) {
    // Insecure context (plain-http LAN origin): no SubtleCrypto, so store the
    // legacy plaintext record shape rather than throwing. There is no at-rest
    // encryption to be had on such an origin either way.
    await storage.setMeta(META_PREFIX + ref, JSON.stringify(material));
    return;
  }
  const key = await getOrCreateKey(storage);
  const record = await encryptMaterial(key, material);
  await storage.setMeta(META_PREFIX + ref, JSON.stringify(record));
}

/**
 * Read+decrypt a stored secret. Transparently migrates a legacy plaintext
 * record by re-encrypting it in place before returning. Returns null for a
 * missing ref or anything that can't be parsed/decrypted — the caller degrades
 * gracefully rather than throwing.
 */
async function readMaterial(storage: ConnectionStorage, ref: string): Promise<SecretMaterial | null> {
  const raw = await storage.getMeta(META_PREFIX + ref);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (isEncryptedRecord(parsed)) {
    try {
      const key = await getOrCreateKey(storage);
      return await decryptRecord(key, parsed);
    } catch {
      return null;
    }
  }
  // Legacy plaintext record: still a plain SecretMaterial shape. Use it, then
  // migrate it to the encrypted envelope so the next read (and the on-disk
  // state) is no longer plaintext. Skip the rewrite entirely when SubtleCrypto
  // is unavailable (insecure origin): writeMaterial would just re-store the
  // identical plaintext — a wasted IndexedDB write on EVERY read, forever.
  const material = parsed as SecretMaterial;
  if (subtleAvailable()) {
    try {
      await writeMaterial(storage, ref, material);
    } catch {
      // Migration failing shouldn't block using the credential this once.
    }
  }
  return material;
}

export function createSecretStore(storage: ConnectionStorage): SecretStore {
  return {
    async set(ref, material) {
      await writeMaterial(storage, ref, material);
    },

    async delete(ref) {
      await storage.setMeta(META_PREFIX + ref, null);
    },

    async resolveAuth(entry) {
      if (entry.auth.mode !== 'basic' || !entry.auth.secretRef) return { mode: 'none' };
      const material = await readMaterial(storage, entry.auth.secretRef);
      if (!material || typeof material.password !== 'string') return { mode: 'none' };
      // The username is authoritative on the stored connection; fall back to
      // the material's username for legacy records that carried it inline.
      const username = entry.auth.username || material.username;
      return username
        ? { mode: 'basic', username, password: material.password }
        : { mode: 'basic', password: material.password };
    },

    async updateUsername(ref, username) {
      const material = await readMaterial(storage, ref);
      if (!material) return;
      const updated: SecretMaterial = { ...material };
      if (username === undefined) delete updated.username;
      else updated.username = username;
      await writeMaterial(storage, ref, updated);
    },
  };
}
