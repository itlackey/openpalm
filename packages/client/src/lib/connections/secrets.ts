/**
 * Per-connection credential material (plan ui-runtime-modes-plan.md §6.6,
 * §6.8): a ConnectionEntry carries only `auth.secretRef` — the actual
 * Basic/Bearer material lives here, in the same client-side storage backend
 * (IndexedDB in the browser), keyed by that ref. These are CONNECTION
 * credentials the user pasted for a guardian/OpenCode endpoint — never host
 * credentials (§8.10).
 *
 * E7 (review 2026-07-10 §E7): material used to be stored as plaintext JSON
 * under that key — trivially readable by any same-origin script (a
 * malicious extension, a supply-chain-compromised dependency, an XSS in a
 * future feature). It is now wrapped with WebCrypto AES-GCM before it ever
 * reaches `storage.setMeta`: a non-extractable key lives in the storage
 * backend's structured-clone area (`getCryptoKey`/`setCryptoKey` — plain
 * getMeta/setMeta are JSON strings and can't carry a CryptoKey), generated
 * once per storage backend and reused for every secret. This still does NOT
 * make credentials safe from a same-origin attacker in the general case: a
 * script running in this origin can call `resolveAuth()`/`set()` itself
 * (the key is non-extractable, not inaccessible — WebCrypto lets same-origin
 * code use a key without ever seeing its bytes, which stops casual
 * "read the DB" exfiltration and DB-only backup/sync leaks, but not a script
 * that can execute in this page). The residual-exposure note in the
 * connections form docs this trade-off for users.
 *
 * Existing plaintext records (written by an install from before this fix
 * shipped) are still readable — resolveAuth()/peekUsername() fall back to
 * a plaintext JSON.parse() when the stored value isn't the encrypted
 * envelope shape — and are transparently re-encrypted in place on first
 * read (lazy migration; no separate migration step/version bump needed).
 */
import type { ConnectionAuth } from '../transport/index.js';
import type { ConnectionEntry, ConnectionStorage } from './index.js';

export type SecretMaterial = {
  username?: string;
  password?: string;
  token?: string;
};

export type SecretStore = {
  set(ref: string, material: SecretMaterial): Promise<void>;
  delete(ref: string): Promise<void>;
  /**
   * Build the transport auth for a connection. Missing or unreadable secret
   * material degrades to { mode: 'none' } — the health probe then reports
   * 'unauthorized' instead of the app crashing.
   */
  resolveAuth(entry: ConnectionEntry): Promise<ConnectionAuth>;
  /**
   * E9 (review 2026-07-10 §E9): the NON-secret half only — never the
   * password/token. Lets the edit form show (and let the user correct) a
   * stored Basic username without ever re-displaying, or requiring a
   * retype of, the password. Undefined when no username is stored (the
   * default-username case) or the ref is unknown.
   */
  peekUsername(ref: string): Promise<string | undefined>;
  /**
   * E9: rewrite ONLY the username half of stored Basic material, preserving
   * whatever password is already stored. This is how the edit form applies
   * a username-only change without forcing the user to retype the
   * password (the bug: previously any edit that didn't retype the password
   * silently kept the OLD auth object wholesale, so a changed username was
   * dropped). `undefined` clears the username (falls back to the transport
   * default). No-op for an unknown ref (nothing to merge into).
   */
  updateUsername(ref: string, username: string | undefined): Promise<void>;
};

const META_PREFIX = 'secret:';
const ENCRYPTED_MARKER = 2 as const;
const AES_GCM_LENGTH = 256;
const IV_BYTES = 12;

type EncryptedRecord = { v: typeof ENCRYPTED_MARKER; iv: string; ciphertext: string };

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

// Explicit `<ArrayBuffer>` (not the bare `Uint8Array`, which TS now widens to
// `Uint8Array<ArrayBufferLike>`): SubtleCrypto's BufferSource params require
// an actual ArrayBuffer-backed view, and this is the array of base64-decoded
// bytes fed straight into crypto.subtle.decrypt()'s iv/ciphertext.
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// F2 (review 2026-07-10 §F2, PR #562 fix round): the naive check-then-act
// below (read storage.getCryptoKey() -> if absent, generate+persist) has an
// `await` between the read and the write. probeAll() on the connections
// page runs resolveAuth() for every connection in ONE Promise.all, and on a
// pre-E7 install every entry lazily migrates via writeMaterial ->
// getOrCreateKey concurrently — without serialization each concurrent
// first-time caller sees "no key yet", generates its OWN key, and the last
// storage.setCryptoKey() wins: every record encrypted under a losing key
// becomes permanently undecryptable (silent credential loss).
//
// Fixed by memoizing the in-flight generation Promise per storage backend
// in this WeakMap. The get-then-set of `pendingKeys` below has NO `await`
// between them, so whichever concurrent caller's continuation resumes
// first (after its own `await storage.getCryptoKey()`) wins the memo
// atomically — JS never interleaves two synchronous stretches of code — and
// every other concurrent caller awaits that SAME promise/key instead of
// racing its own. The memo is keyed by the storage instance (not global) so
// unrelated storage backends — e.g. two independent stores in tests — never
// share a key.
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
  const key = await getOrCreateKey(storage);
  const record = await encryptMaterial(key, material);
  await storage.setMeta(META_PREFIX + ref, JSON.stringify(record));
}

/**
 * Read+decrypt a stored secret. Transparently migrates a legacy plaintext
 * record (pre-E7) by re-encrypting it in place before returning. Returns
 * null for a missing ref or anything that can't be parsed/decrypted — the
 * caller degrades gracefully rather than throwing.
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
  // Legacy plaintext record (pre-E7 install): still a plain SecretMaterial
  // shape. Use it, then migrate it to the encrypted envelope so the next
  // read (and the on-disk state) is no longer plaintext.
  const material = parsed as SecretMaterial;
  try {
    await writeMaterial(storage, ref, material);
  } catch {
    // Migration failing shouldn't block using the credential this once.
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
      if (entry.auth.mode === 'none' || !entry.auth.secretRef) return { mode: 'none' };
      const material = await readMaterial(storage, entry.auth.secretRef);
      if (!material) return { mode: 'none' };
      if (entry.auth.mode === 'basic' && typeof material.password === 'string') {
        return material.username
          ? { mode: 'basic', username: material.username, password: material.password }
          : { mode: 'basic', password: material.password };
      }
      if (entry.auth.mode === 'bearer' && typeof material.token === 'string') {
        return { mode: 'bearer', token: material.token };
      }
      return { mode: 'none' };
    },

    async peekUsername(ref) {
      const material = await readMaterial(storage, ref);
      return material?.username;
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
