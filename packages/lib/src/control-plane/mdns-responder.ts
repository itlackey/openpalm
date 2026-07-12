/**
 * Host control-plane mDNS self-advertisement (#488).
 *
 * Runs inside the long-lived host UI server process (every supervisor —
 * `openpalm ui serve`, `openpalm`, Electron — spawns it; see
 * `hooks.server.ts`'s one-shot startup init). NOT run inside the guardian
 * container: container mDNS on the default Docker bridge network never
 * reaches the physical LAN and `network_mode: host` would break the
 * assistant/guardian network-partitioning invariants (and is inert on
 * macOS anyway). See `docs/technical/network-partitioning-d5a.md` for the
 * full rationale (D1 in `.github/roadmap/0.13.0/specs/488.md`).
 *
 * Layout: pure encode/decode/gating section first (no side-effecting
 * imports), socket section second, reconcile singleton last.
 *
 * Scope: `udp4` + A records only (no IPv6/AAAA), no RFC 6762 §8 probing/
 * conflict defense (we are the only intended publisher of these names —
 * `OP_MDNS=off` is the escape hatch for a foreign publisher on the LAN).
 */
import dgram from "node:dgram";
import { networkInterfaces } from "node:os";
import { createLogger } from "../logger.js";
import { isLoopback } from "./bind-warning.js";
import { readStackEnv } from "./secrets.js";

const logger = createLogger("mdns");

// ── Constants ──────────────────────────────────────────────────────────────

const MDNS_ADDR = "224.0.0.251";
const MDNS_PORT = 5353;
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const TYPE_ANY = 255;
const CLASS_IN = 1;
const CACHE_FLUSH_BIT = 0x8000;
const TTL = 120;
const HTTP_SERVICE = "_http._tcp.local";
const DEFAULT_GUARDIAN_PORT = 3830;
const DEFAULT_ASSISTANT_PORT = 3800;
/** QR (response) + AA (authoritative answer) flag bits. */
const QR_AA_FLAGS = 0x8400;
/** Bounded hop limit for compression-pointer following in the parser. */
const MAX_NAME_POINTER_HOPS = 16;

// ── Pure: name derivation ─────────────────────────────────────────────────

/**
 * Sanitize an arbitrary string into a DNS label: lowercase, map every
 * character outside `[a-z0-9-]` (including `_`) to `-`, collapse `-` runs,
 * strip leading/trailing `-`, truncate to `maxLength`, and fall back to
 * `"openpalm"` if nothing survives. `maxLength` defaults to 54 so the
 * guardian variant (`<label>-guardian`, +9 chars) still fits the 63-char
 * DNS label limit.
 */
export function sanitizeDnsLabel(raw: string, maxLength = 54): string {
  const trimmed = raw.trim().toLowerCase();
  const mapped = trimmed.replace(/[^a-z0-9-]/g, "-");
  const collapsed = mapped.replace(/-+/g, "-");
  const stripped = collapsed.replace(/^-+|-+$/g, "");
  // Re-strip AFTER truncation: slicing can land on a hyphen and re-introduce a
  // trailing "-" (an invalid DNS label ending, and an ugly "--guardian" once
  // the guardian suffix is appended).
  const truncated = stripped.slice(0, maxLength).replace(/-+$/g, "");
  return truncated || "openpalm";
}

/**
 * Derive the base label and full `.local` names from `OP_PROJECT_NAME`
 * (there is no structured "assistant name" — persona is free-text
 * markdown). Defaults to `openpalm`.
 */
export function deriveMdnsNames(env: Record<string, string | undefined>): {
  base: string;
  assistantName: string;
  guardianName: string;
} {
  const base = sanitizeDnsLabel(env.OP_PROJECT_NAME ?? "openpalm");
  return { base, assistantName: `${base}.local`, guardianName: `${base}-guardian.local` };
}

// ── Pure: gating ───────────────────────────────────────────────────────────

export type MdnsAdvertisement = {
  service: "assistant" | "guardian";
  /** lowercase FQDN, e.g. "openpalm-guardian.local" */
  name: string;
  /** host TCP port (OP_GUARDIAN_PORT / OP_ASSISTANT_PORT defaults) */
  port: number;
  /** IPv4 addresses for A answers */
  addresses: string[];
};

export type MdnsStatus = {
  assistant: { name: string; port: number; advertised: boolean };
  guardian: { name: string; port: number; advertised: boolean };
};

function isMdnsOffToken(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "0" || v === "false" || v === "off" || v === "no";
}

function isGuardianGated(env: Record<string, string | undefined>): boolean {
  if (isMdnsOffToken(env.OP_MDNS)) return false;
  const bind = env.OP_BIND_ADDRESS;
  return !!bind && !isLoopback(bind);
}

function isAssistantGated(env: Record<string, string | undefined>): boolean {
  if (isMdnsOffToken(env.OP_MDNS)) return false;
  // No OP_BIND_ADDRESS fallback here — mirrors core.compose.yml:98, where the
  // assistant host port line does NOT nest OP_BIND_ADDRESS.
  const bind = env.OP_ASSISTANT_BIND_ADDRESS;
  return !!bind && !isLoopback(bind);
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultHostIpv4(): string[] {
  const interfaces = networkInterfaces();
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      // node:os types `family` as the string literal union in current
      // @types/node; older Node runtimes can report the numeric family (4)
      // instead, so compare loosely without narrowing entry.family's type.
      const family: unknown = entry.family;
      const isIpv4 = family === "IPv4" || family === 4;
      if (isIpv4 && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

/** A specific bind IP narrows the addresses; a wildcard bind uses the host interface list. */
function resolveAdvertAddresses(bind: string, hostIpv4: string[]): string[] {
  const v = bind.trim();
  if (v !== "" && v !== "0.0.0.0" && v !== "::") return [v];
  return hostIpv4;
}

/**
 * Resolve which names should be advertised right now, given non-secret env
 * (typically `readStackEnv(homeDir)`). Disabled entirely when `OP_MDNS`
 * trims/lowercases to "0"/"false"/"off"/"no". Guardian advert iff
 * `OP_BIND_ADDRESS` is set and non-loopback; assistant advert iff
 * `OP_ASSISTANT_BIND_ADDRESS` is set and non-loopback. An advert with zero
 * resolved addresses is dropped.
 */
export function resolveMdnsAdvertisements(
  env: Record<string, string | undefined>,
  hostIpv4: string[] = defaultHostIpv4(),
): MdnsAdvertisement[] {
  const names = deriveMdnsNames(env);
  const adverts: MdnsAdvertisement[] = [];

  if (isGuardianGated(env)) {
    const bind = env.OP_BIND_ADDRESS as string;
    const addresses = resolveAdvertAddresses(bind, hostIpv4);
    if (addresses.length > 0) {
      adverts.push({
        service: "guardian",
        name: names.guardianName,
        port: parsePort(env.OP_GUARDIAN_PORT, DEFAULT_GUARDIAN_PORT),
        addresses,
      });
    }
  }

  if (isAssistantGated(env)) {
    const bind = env.OP_ASSISTANT_BIND_ADDRESS as string;
    const addresses = resolveAdvertAddresses(bind, hostIpv4);
    if (addresses.length > 0) {
      adverts.push({
        service: "assistant",
        name: names.assistantName,
        port: parsePort(env.OP_ASSISTANT_PORT, DEFAULT_ASSISTANT_PORT),
        addresses,
      });
    }
  }

  return adverts;
}

/**
 * Names/ports/advertised-state for the admin UI, independent of whether any
 * host IPv4 address can actually be resolved right now — `advertised`
 * reflects the bind-address gate only (D6: gating is bind-address-only), so
 * this never needs a `hostIpv4` param.
 */
export function resolveMdnsStatus(env: Record<string, string | undefined>): MdnsStatus {
  const names = deriveMdnsNames(env);
  return {
    assistant: {
      name: names.assistantName,
      port: parsePort(env.OP_ASSISTANT_PORT, DEFAULT_ASSISTANT_PORT),
      advertised: isAssistantGated(env),
    },
    guardian: {
      name: names.guardianName,
      port: parsePort(env.OP_GUARDIAN_PORT, DEFAULT_GUARDIAN_PORT),
      advertised: isGuardianGated(env),
    },
  };
}

// ── Pure: DNS wire format (no name compression — legal per RFC 1035, keeps
//    the encoder trivial; the parser follows compression pointers defensively
//    since it must handle arbitrary incoming query bytes) ──────────────────

export type DnsQuestion = { name: string; type: number; qclass: number };

function readU16(buf: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > buf.length) throw new RangeError("mdns: read past end of buffer");
  return ((buf[offset] as number) << 8) | (buf[offset + 1] as number);
}

function decodeName(buf: Uint8Array, offset: number): { name: string; next: number } | null {
  const labels: string[] = [];
  let pos = offset;
  let hops = 0;
  let next = -1;
  while (true) {
    if (pos < 0 || pos >= buf.length) return null;
    const len = buf[pos] as number;
    if ((len & 0xc0) === 0xc0) {
      // Compression pointer: bounded-hop follow, never loop forever.
      if (pos + 1 >= buf.length) return null;
      hops += 1;
      if (hops > MAX_NAME_POINTER_HOPS) return null;
      if (next === -1) next = pos + 2;
      const lo = buf[pos + 1] as number;
      pos = ((len & 0x3f) << 8) | lo;
      continue;
    }
    if (len === 0) {
      pos += 1;
      if (next === -1) next = pos;
      break;
    }
    if (pos + 1 + len > buf.length) return null;
    let label = "";
    for (let i = 0; i < len; i++) label += String.fromCharCode(buf[pos + 1 + i] as number);
    labels.push(label);
    pos += 1 + len;
  }
  return { name: labels.join("."), next };
}

/**
 * Decode the header + question section of a DNS/mDNS message. Defensive:
 * bounds-checked throughout, returns `null` (never throws) on QR=1
 * (response, not a query) or any malformation/truncation.
 */
export function parseDnsQuestions(msg: Uint8Array): DnsQuestion[] | null {
  try {
    if (msg.length < 12) return null;
    const flags = readU16(msg, 2);
    if ((flags & 0x8000) !== 0) return null; // QR=1 → a response, not a query
    const qdcount = readU16(msg, 4);
    let pos = 12;
    const questions: DnsQuestion[] = [];
    for (let i = 0; i < qdcount; i++) {
      const decoded = decodeName(msg, pos);
      if (!decoded) return null;
      const type = readU16(msg, decoded.next);
      const qclass = readU16(msg, decoded.next + 2);
      questions.push({ name: decoded.name.toLowerCase(), type, qclass });
      pos = decoded.next + 4;
    }
    return questions;
  } catch {
    return null;
  }
}

function buildHeader(
  id: number,
  flags: number,
  qdcount: number,
  ancount = 0,
  nscount = 0,
  arcount = 0,
): number[] {
  return [
    (id >> 8) & 0xff,
    id & 0xff,
    (flags >> 8) & 0xff,
    flags & 0xff,
    (qdcount >> 8) & 0xff,
    qdcount & 0xff,
    (ancount >> 8) & 0xff,
    ancount & 0xff,
    (nscount >> 8) & 0xff,
    nscount & 0xff,
    (arcount >> 8) & 0xff,
    arcount & 0xff,
  ];
}

function encodeName(name: string): number[] {
  const bytes: number[] = [];
  for (const label of name.split(".")) {
    if (label.length === 0) continue;
    bytes.push(label.length);
    for (let i = 0; i < label.length; i++) bytes.push(label.charCodeAt(i) & 0xff);
  }
  bytes.push(0);
  return bytes;
}

function encodeRR(name: string, type: number, rrClass: number, ttl: number, rdata: number[]): number[] {
  const rdlength = rdata.length;
  return [
    ...encodeName(name),
    (type >> 8) & 0xff,
    type & 0xff,
    (rrClass >> 8) & 0xff,
    rrClass & 0xff,
    (ttl >>> 24) & 0xff,
    (ttl >>> 16) & 0xff,
    (ttl >>> 8) & 0xff,
    ttl & 0xff,
    (rdlength >> 8) & 0xff,
    rdlength & 0xff,
    ...rdata,
  ];
}

function ipv4ToBytes(address: string): number[] {
  return address.split(".").map((part) => Number.parseInt(part, 10) & 0xff);
}

function buildARecord(name: string, address: string, ttl = TTL): number[] {
  return encodeRR(name, TYPE_A, CLASS_IN | CACHE_FLUSH_BIT, ttl, ipv4ToBytes(address));
}

function mdnsInstanceName(name: string): string {
  const base = name.toLowerCase().endsWith(".local") ? name.slice(0, -".local".length) : name;
  return `${base}.${HTTP_SERVICE}`;
}

function buildPtrRecord(instanceName: string): number[] {
  return encodeRR(HTTP_SERVICE, TYPE_PTR, CLASS_IN, TTL, encodeName(instanceName));
}

function buildSrvRecord(instanceName: string, target: string, port: number): number[] {
  const rdata = [0, 0, 0, 0, (port >> 8) & 0xff, port & 0xff, ...encodeName(target)];
  return encodeRR(instanceName, TYPE_SRV, CLASS_IN, TTL, rdata);
}

function buildTxtRecord(instanceName: string, strings: string[]): number[] {
  const rdata: number[] = [];
  for (const s of strings) {
    rdata.push(s.length & 0xff);
    for (let i = 0; i < s.length; i++) rdata.push(s.charCodeAt(i) & 0xff);
  }
  return encodeRR(instanceName, TYPE_TXT, CLASS_IN, TTL, rdata);
}

function buildPacket(id: number, flags: number, answers: number[][], additionals: number[][]): Uint8Array {
  const header = buildHeader(id, flags, 0, answers.length, 0, additionals.length);
  return new Uint8Array([...header, ...answers.flat(), ...additionals.flat()]);
}

/**
 * Build an answer packet for `questions` against the currently-advertised
 * `adverts`. Answers are multicast-shaped (ID 0) unless `opts.queryId` is
 * passed (legacy unicast reply, which preserves the original query ID). `A`
 * / `TYPE_ANY` queries match a name exactly (case-insensitively); `PTR` /
 * `TYPE_ANY` queries for `_http._tcp.local` list one instance per advert
 * with SRV/TXT/A in the additional section. Returns `null` when nothing
 * matches (no response packet at all).
 */
export function buildMdnsAnswer(
  questions: DnsQuestion[],
  adverts: MdnsAdvertisement[],
  opts: { queryId?: number } = {},
): Uint8Array | null {
  const answers: number[][] = [];
  const additionals: number[][] = [];

  for (const q of questions) {
    const qName = q.name.toLowerCase();
    if (q.type === TYPE_A || q.type === TYPE_ANY) {
      const advert = adverts.find((a) => a.name.toLowerCase() === qName);
      if (advert) {
        for (const address of advert.addresses) answers.push(buildARecord(advert.name, address));
      }
    }
    if ((q.type === TYPE_PTR || q.type === TYPE_ANY) && qName === HTTP_SERVICE) {
      for (const advert of adverts) {
        const instanceName = mdnsInstanceName(advert.name);
        answers.push(buildPtrRecord(instanceName));
        additionals.push(buildSrvRecord(instanceName, advert.name, advert.port));
        additionals.push(buildTxtRecord(instanceName, ["path=/"]));
        for (const address of advert.addresses) additionals.push(buildARecord(advert.name, address));
      }
    }
  }

  if (answers.length === 0) return null;
  return buildPacket(opts.queryId ?? 0, QR_AA_FLAGS, answers, additionals);
}

/** Gratuitous announcement (one A answer per advert address) sent at startup. */
export function buildMdnsAnnouncement(adverts: MdnsAdvertisement[]): Uint8Array | null {
  const answers = adverts.flatMap((a) => a.addresses.map((address) => buildARecord(a.name, address)));
  if (answers.length === 0) return null;
  return buildPacket(0, QR_AA_FLAGS, answers, []);
}

/** TTL-0 goodbye records for every advert, sent best-effort on stop(). */
export function buildMdnsGoodbye(adverts: MdnsAdvertisement[]): Uint8Array | null {
  const answers = adverts.flatMap((a) => a.addresses.map((address) => buildARecord(a.name, address, 0)));
  if (answers.length === 0) return null;
  return buildPacket(0, QR_AA_FLAGS, answers, []);
}

// ── Socket layer ───────────────────────────────────────────────────────────

export type MdnsRemoteInfo = { address: string; port: number };

export type MdnsSocketLike = {
  bind(port: number, address: string, cb?: () => void): void;
  addMembership(mcastAddr: string): void;
  setMulticastTTL(ttl: number): void;
  send(msg: Uint8Array, port: number, address: string): void;
  close(): void;
  on(event: "message", cb: (msg: Uint8Array, rinfo: MdnsRemoteInfo) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  unref?(): void;
};

export type MdnsSocketFactory = () => MdnsSocketLike;
export type MdnsResponderHandle = { stop(): void };

/** Test-only override consulted whenever a caller doesn't pass `deps.createSocket`. */
let testSocketFactory: MdnsSocketFactory | null = null;

export function _setMdnsSocketFactoryForTests(factory: MdnsSocketFactory | null): void {
  testSocketFactory = factory;
}

function defaultSocketFactory(): MdnsSocketLike {
  return dgram.createSocket({ type: "udp4", reuseAddr: true }) as unknown as MdnsSocketLike;
}

/**
 * Build a live responder for `adverts`. Returns both the public handle
 * (`stop()` — goodbye + close) and an internal `silentClose` (close with no
 * goodbye packet, used only by `_resetMdnsResponderForTests`). All socket
 * failures are logged `warn` and swallowed — advertisement is a convenience
 * and must never take the UI server down.
 */
function createResponder(
  adverts: MdnsAdvertisement[],
  deps: { createSocket?: MdnsSocketFactory } = {},
): { handle: MdnsResponderHandle; silentClose: () => void } | null {
  if (adverts.length === 0) return null;

  const factory = deps.createSocket ?? testSocketFactory ?? defaultSocketFactory;
  const names = adverts.map((a) => a.name);
  let socket: MdnsSocketLike;
  try {
    socket = factory();
  } catch (err) {
    logger.warn("mdns: failed to create socket", { error: String(err), names });
    return null;
  }

  let stopped = false;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;

  function safeSend(msg: Uint8Array, port: number, address: string): void {
    try {
      socket.send(msg, port, address);
    } catch (err) {
      logger.warn("mdns: send failed", { error: String(err), names });
    }
  }

  function announce(): void {
    const packet = buildMdnsAnnouncement(adverts);
    if (packet) safeSend(packet, MDNS_PORT, MDNS_ADDR);
  }

  try {
    socket.on("message", (msg, rinfo) => {
      if (stopped) return;
      try {
        const questions = parseDnsQuestions(msg);
        if (!questions) return;
        const legacy = rinfo.port !== MDNS_PORT;
        const answer = buildMdnsAnswer(questions, adverts, legacy ? { queryId: readU16(msg, 0) } : {});
        if (!answer) return;
        if (legacy) safeSend(answer, rinfo.port, rinfo.address);
        else safeSend(answer, MDNS_PORT, MDNS_ADDR);
      } catch (err) {
        logger.warn("mdns: message handling failed", { error: String(err), names });
      }
    });
    socket.on("error", (err) => {
      logger.warn("mdns: socket error", { error: err.message, names });
    });
  } catch (err) {
    logger.warn("mdns: listener setup failed", { error: String(err), names });
  }

  try {
    socket.bind(MDNS_PORT, "0.0.0.0", () => {
      try {
        socket.addMembership(MDNS_ADDR);
        socket.setMulticastTTL(255);
        socket.unref?.();
        announce();
        // Second startup announcement per RFC 6762 startup guidance, via an
        // unref'd timer so it never keeps the process alive.
        announceTimer = setTimeout(() => announce(), 1000);
        announceTimer.unref?.();
      } catch (err) {
        logger.warn("mdns: post-bind setup failed", { error: String(err), names });
      }
    });
  } catch (err) {
    logger.warn("mdns: bind failed", { error: String(err), names });
    try {
      socket.close();
    } catch {
      /* best-effort */
    }
    return null;
  }

  function silentClose(): void {
    if (stopped) return;
    stopped = true;
    if (announceTimer) clearTimeout(announceTimer);
    try {
      socket.close();
    } catch (err) {
      logger.warn("mdns: close failed", { error: String(err), names });
    }
  }

  return {
    handle: {
      stop(): void {
        if (stopped) return;
        stopped = true;
        if (announceTimer) clearTimeout(announceTimer);
        try {
          const goodbye = buildMdnsGoodbye(adverts);
          if (goodbye) safeSend(goodbye, MDNS_PORT, MDNS_ADDR);
        } catch (err) {
          logger.warn("mdns: goodbye failed", { error: String(err), names });
        }
        try {
          socket.close();
        } catch (err) {
          logger.warn("mdns: close failed", { error: String(err), names });
        }
      },
    },
    silentClose,
  };
}

/**
 * Start a responder for `adverts`. Returns `null` and opens no socket at
 * all when there is nothing to advertise (the loopback-default "no socket"
 * guarantee) — the socket factory is never even consulted in that case.
 */
export function startMdnsResponder(
  adverts: MdnsAdvertisement[],
  deps: { createSocket?: MdnsSocketFactory } = {},
): MdnsResponderHandle | null {
  return createResponder(adverts, deps)?.handle ?? null;
}

// ── Reconcile singleton ─────────────────────────────────────────────────────
//
// Explicit, documented owner of the single live responder — mirrors
// hooks.server.ts's startupApplyDone one-shot pattern. "No hidden global
// state" is satisfied by this single module-scoped `active`, whose ownership
// is this module only.

let active: { key: string; handle: MdnsResponderHandle; silentClose: () => void } | null = null;

/**
 * Reconcile the live responder against the current stack.env (read fresh on
 * every call — never process.env for the gate vars, since hooks.server.ts's
 * startup promotion is only-if-unset and would go stale after a PUT). The
 * single process-env exception: `OP_MDNS` in `processEnv` force-disables
 * (operator/test kill switch), checked alongside the stack.env value. Never
 * throws. Returns the effective `MdnsStatus` so route handlers can echo it.
 */
export function reconcileMdnsResponder(
  homeDir: string,
  deps: {
    env?: Record<string, string | undefined>;
    processEnv?: Record<string, string | undefined>;
    createSocket?: MdnsSocketFactory;
    hostIpv4?: string[];
  } = {},
): MdnsStatus {
  let env: Record<string, string | undefined>;
  try {
    env = deps.env ?? readStackEnv(homeDir);
  } catch (err) {
    logger.warn("mdns: reading stack.env failed", { error: String(err) });
    env = {};
  }

  const processEnv = deps.processEnv ?? process.env;
  const effectiveEnv = isMdnsOffToken(processEnv.OP_MDNS) ? { ...env, OP_MDNS: "off" } : env;

  try {
    const adverts = resolveMdnsAdvertisements(effectiveEnv, deps.hostIpv4);
    const key = JSON.stringify(adverts);

    if (active && active.key === key) {
      return resolveMdnsStatus(effectiveEnv);
    }

    if (active) {
      try {
        active.handle.stop();
      } catch (err) {
        logger.warn("mdns: stop failed during reconcile", { error: String(err) });
      }
      active = null;
    }

    if (adverts.length > 0) {
      const created = createResponder(adverts, { createSocket: deps.createSocket });
      if (created) active = { key, ...created };
    }
  } catch (err) {
    logger.warn("mdns: reconcile failed", { error: String(err) });
  }

  return resolveMdnsStatus(effectiveEnv);
}

/** Test-only: stop the active responder (no goodbye) and clear the singleton. */
export function _resetMdnsResponderForTests(): void {
  if (active) {
    try {
      active.silentClose();
    } catch (err) {
      logger.warn("mdns: silent close failed during test reset", { error: String(err) });
    }
    active = null;
  }
}
