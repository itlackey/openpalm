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
 * The DNS wire format and multicast socket are handled by the maintained
 * `multicast-dns` package; this module owns only the OpenPalm-specific policy:
 * which `.local` names to advertise, gated on the bind-address env, and a
 * reconcile singleton. Scope: A records + an `_http._tcp` service instance.
 */
import makeMdns from "multicast-dns";
import { networkInterfaces } from "node:os";
import { createLogger } from "../logger.js";
import { isLoopback } from "./bind-warning.js";
import { readStackEnv } from "./secrets.js";

const logger = createLogger("mdns");

// ── Constants ──────────────────────────────────────────────────────────────

const MDNS_PORT = 5353;
const TTL = 120;
const HTTP_SERVICE = "_http._tcp.local";
const DEFAULT_GUARDIAN_PORT = 3830;
const DEFAULT_ASSISTANT_PORT = 3810;
const DEFAULT_UI_PORT = 3800;

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
  /** host TCP port (OP_UI_PORT / OP_ASSISTANT_PORT / OP_GUARDIAN_PORT defaults) */
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
  // The advertised `<name>-guardian.local:3830` is the direct ingress front
  // door. Never advertise it while direct ingress is disabled — otherwise the
  // LAN is pointed at a listener that 404s. Matches guardian server.ts: only
  // literal 'true'. Both values are generated together from the
  // `guardianNetwork` toggle, so they can no longer disagree.
  if (env.GUARDIAN_DIRECT_INGRESS !== "true") return false;
  return isOpen(env.OP_GUARDIAN_BIND_ADDRESS);
}

function isOpen(bind: string | undefined): boolean {
  // Flat, like every other bind now: generated explicitly, so unset means
  // loopback rather than "inherit from somewhere else".
  return !!bind && !isLoopback(bind);
}

/**
 * The listener `<project>.local` should point at, or null when nothing is
 * published under that name.
 *
 * `<project>.local` is the name a PERSON types into a browser, so it follows
 * the FRONT DOOR — the OpenPalm UI on `OP_UI_PORT`. That is what
 * `networkAccess` publishes, and OpenCode deliberately stays on loopback
 * behind the UI's `/oc` proxy in that configuration. Gating this name on
 * `OP_ASSISTANT_BIND_ADDRESS` (as it was when publishing OpenCode WAS how you
 * reached the assistant) means the default home install — network access on,
 * nothing else — advertises no `.local` name at all, which is precisely the
 * "find the assistant from any device" case the name exists for.
 *
 * The assistant API is the fallback, not the primary: a headless install that
 * publishes only OpenCode (`assistantDirect` alone) still gets its name. When
 * both are open the UI wins, because both live at the same host address and
 * only one SRV port can be advertised for one name.
 */
function resolveFrontDoor(
  env: Record<string, string | undefined>,
): { bind: string; port: number } | null {
  if (isMdnsOffToken(env.OP_MDNS)) return null;
  if (isOpen(env.OP_UI_BIND_ADDRESS)) {
    return {
      bind: env.OP_UI_BIND_ADDRESS as string,
      port: parsePort(env.OP_UI_PORT, DEFAULT_UI_PORT),
    };
  }
  if (isOpen(env.OP_ASSISTANT_BIND_ADDRESS)) {
    return {
      bind: env.OP_ASSISTANT_BIND_ADDRESS as string,
      port: parsePort(env.OP_ASSISTANT_PORT, DEFAULT_ASSISTANT_PORT),
    };
  }
  return null;
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
      const isIpv4Family = family === "IPv4" || family === 4;
      if (isIpv4Family && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}

/** True only for a dotted-quad IPv4 literal (4 octets, each 0-255). */
function isIpv4(address: string): boolean {
  const parts = address.trim().split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** A specific bind IP narrows the addresses; a wildcard bind uses the host interface list. */
function resolveAdvertAddresses(bind: string, hostIpv4: string[]): string[] {
  const v = bind.trim();
  const candidates = v !== "" && v !== "0.0.0.0" && v !== "::" ? [v] : hostIpv4;
  // PR #564 r3566892051: only IPv4 addresses can be encoded as A records. A
  // specific IPv6 literal / hostname bind (or a non-IPv4 host address) is
  // skipped rather than mangled; an advert that resolves to zero addresses is
  // dropped by the caller.
  return candidates.filter(isIpv4);
}

/**
 * Resolve which names should be advertised right now, given non-secret env
 * (typically `readStackEnv(homeDir)`). Disabled entirely when `OP_MDNS`
 * trims/lowercases to "0"/"false"/"off"/"no". Guardian advert iff
 * `OP_GUARDIAN_BIND_ADDRESS` is set and non-loopback with direct ingress on;
 * assistant advert iff something is published at the front door (see
 * {@link resolveFrontDoor}). An advert with zero resolved addresses is dropped.
 */
export function resolveMdnsAdvertisements(
  env: Record<string, string | undefined>,
  hostIpv4: string[] = defaultHostIpv4(),
): MdnsAdvertisement[] {
  const names = deriveMdnsNames(env);
  const adverts: MdnsAdvertisement[] = [];

  if (isGuardianGated(env)) {
    const bind = env.OP_GUARDIAN_BIND_ADDRESS as string;
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

  const frontDoor = resolveFrontDoor(env);
  if (frontDoor) {
    const addresses = resolveAdvertAddresses(frontDoor.bind, hostIpv4);
    if (addresses.length > 0) {
      adverts.push({
        service: "assistant",
        name: names.assistantName,
        port: frontDoor.port,
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
 *
 * `assistant.port` is the port that WOULD be advertised, so an unpublished
 * install still shows the name and port it would get. It reads the front door
 * the same way the advert does, which is why the closed case falls back to the
 * UI port rather than the assistant's.
 */
export function resolveMdnsStatus(env: Record<string, string | undefined>): MdnsStatus {
  const names = deriveMdnsNames(env);
  const frontDoor = resolveFrontDoor(env);
  return {
    assistant: {
      name: names.assistantName,
      port: frontDoor?.port ?? parsePort(env.OP_UI_PORT, DEFAULT_UI_PORT),
      advertised: frontDoor !== null,
    },
    guardian: {
      name: names.guardianName,
      port: parsePort(env.OP_GUARDIAN_PORT, DEFAULT_GUARDIAN_PORT),
      advertised: isGuardianGated(env),
    },
  };
}

// ── Answer building (record objects; the library encodes the wire bytes) ────

/** The `<name>._http._tcp.local` service instance for a `<name>.local` host. */
function mdnsInstanceName(name: string): string {
  const base = name.toLowerCase().endsWith(".local") ? name.slice(0, -".local".length) : name;
  return `${base}.${HTTP_SERVICE}`;
}

export type MdnsRemoteInfo = { address: string; port: number };

/** A record object in the shape `multicast-dns` (dns-packet) encodes. */
export type MdnsAnswer = {
  name: string;
  type: "A" | "PTR" | "SRV" | "TXT";
  ttl: number;
  flush?: boolean;
  data: unknown;
};

type MdnsQuestion = { name?: string; type?: string };
type MdnsQueryMessage = { questions?: MdnsQuestion[] };

/**
 * Build the answer + additional records for `questions` against the currently
 * advertised `adverts`. `A`/`ANY` queries match a `.local` name exactly; `PTR`/
 * `ANY` queries for `_http._tcp.local` list one service instance per advert
 * with SRV/TXT/A in the additional section. Returns `null` when nothing matches.
 */
function buildResponse(
  questions: MdnsQuestion[],
  adverts: MdnsAdvertisement[],
): { answers: MdnsAnswer[]; additionals: MdnsAnswer[] } | null {
  const answers: MdnsAnswer[] = [];
  const additionals: MdnsAnswer[] = [];

  const aRecord = (name: string, address: string): MdnsAnswer => ({ name, type: "A", ttl: TTL, flush: true, data: address });

  for (const q of questions) {
    const qName = (q.name ?? "").toLowerCase();
    const qType = q.type;
    if (qType === "A" || qType === "ANY") {
      const advert = adverts.find((a) => a.name.toLowerCase() === qName);
      if (advert) for (const address of advert.addresses) answers.push(aRecord(advert.name, address));
    }
    if ((qType === "PTR" || qType === "ANY") && qName === HTTP_SERVICE) {
      for (const advert of adverts) {
        const instance = mdnsInstanceName(advert.name);
        answers.push({ name: HTTP_SERVICE, type: "PTR", ttl: TTL, data: instance });
        additionals.push({ name: instance, type: "SRV", ttl: TTL, data: { port: advert.port, target: advert.name } });
        additionals.push({ name: instance, type: "TXT", ttl: TTL, data: ["path=/"] });
        for (const address of advert.addresses) additionals.push(aRecord(advert.name, address));
      }
    }
  }

  if (answers.length === 0) return null;
  return { answers, additionals };
}

/** Gratuitous announcement (one A answer per advert address). */
function announcementAnswers(adverts: MdnsAdvertisement[]): MdnsAnswer[] {
  return adverts.flatMap((a) => a.addresses.map((address): MdnsAnswer => ({ name: a.name, type: "A", ttl: TTL, flush: true, data: address })));
}

/** TTL-0 goodbye records for every advert address, sent best-effort on stop(). */
function goodbyeAnswers(adverts: MdnsAdvertisement[]): MdnsAnswer[] {
  return adverts.flatMap((a) => a.addresses.map((address): MdnsAnswer => ({ name: a.name, type: "A", ttl: 0, flush: true, data: address })));
}

// ── Responder (multicast-dns) ───────────────────────────────────────────────

/** The subset of the `multicast-dns` instance this module uses. */
export type MdnsInstance = {
  on(event: "query", handler: (message: MdnsQueryMessage, rinfo: MdnsRemoteInfo) => void): void;
  on(event: "warning" | "error", handler: (err: Error) => void): void;
  respond(res: { answers: MdnsAnswer[]; additionals?: MdnsAnswer[] }, rinfo?: MdnsRemoteInfo): void;
  destroy(): void;
};

export type MdnsFactory = () => MdnsInstance;
export type MdnsResponderHandle = { stop(): void };

/** Test-only override consulted whenever a caller doesn't pass `deps.makeMdns`. */
let testMdnsFactory: MdnsFactory | null = null;

export function _setMdnsFactoryForTests(factory: MdnsFactory | null): void {
  testMdnsFactory = factory;
}

function defaultMdnsFactory(): MdnsInstance {
  // loopback:false so we do not receive (and re-answer) our own multicast.
  return makeMdns({ loopback: false }) as unknown as MdnsInstance;
}

/**
 * Build a live responder for `adverts`. Returns the public handle (`stop()` —
 * goodbye + destroy) plus an internal `silentClose` (destroy with no goodbye,
 * used only by `_resetMdnsResponderForTests`). All failures are logged `warn`
 * and swallowed — advertisement is a convenience and must never take the UI
 * server down.
 */
function createResponder(
  adverts: MdnsAdvertisement[],
  deps: { makeMdns?: MdnsFactory } = {},
): { handle: MdnsResponderHandle; silentClose: () => void } | null {
  if (adverts.length === 0) return null;

  const factory = deps.makeMdns ?? testMdnsFactory ?? defaultMdnsFactory;
  const names = adverts.map((a) => a.name);
  let mdns: MdnsInstance;
  try {
    mdns = factory();
  } catch (err) {
    logger.warn("mdns: failed to create socket", { error: String(err), names });
    return null;
  }

  let stopped = false;
  let announceTimer: ReturnType<typeof setTimeout> | null = null;

  function announce(): void {
    const answers = announcementAnswers(adverts);
    if (answers.length === 0) return;
    try {
      mdns.respond({ answers });
    } catch (err) {
      logger.warn("mdns: send failed", { error: String(err), names });
    }
  }

  try {
    mdns.on("query", (message, rinfo) => {
      if (stopped) return;
      try {
        const res = buildResponse(message.questions ?? [], adverts);
        if (!res) return;
        // A legacy-unicast query (source port ≠ 5353, RFC 6762 §6.7) is answered
        // back to the sender; a standard multicast query is answered to the group.
        const legacy = rinfo.port !== MDNS_PORT;
        mdns.respond(res, legacy ? rinfo : undefined);
      } catch (err) {
        logger.warn("mdns: message handling failed", { error: String(err), names });
      }
    });
    mdns.on("error", (err) => logger.warn("mdns: socket error", { error: err.message, names }));
    mdns.on("warning", (err) => logger.warn("mdns: warning", { error: err.message, names }));
  } catch (err) {
    logger.warn("mdns: listener setup failed", { error: String(err), names });
  }

  announce();
  // Second startup announcement per RFC 6762 guidance, via an unref'd timer so
  // it never keeps the process alive.
  announceTimer = setTimeout(() => announce(), 1000);
  announceTimer.unref?.();

  function destroy(): void {
    if (announceTimer) clearTimeout(announceTimer);
    try {
      mdns.destroy();
    } catch (err) {
      logger.warn("mdns: close failed", { error: String(err), names });
    }
  }

  function silentClose(): void {
    if (stopped) return;
    stopped = true;
    destroy();
  }

  return {
    handle: {
      stop(): void {
        if (stopped) return;
        stopped = true;
        try {
          const answers = goodbyeAnswers(adverts);
          if (answers.length > 0) mdns.respond({ answers });
        } catch (err) {
          logger.warn("mdns: goodbye failed", { error: String(err), names });
        }
        destroy();
      },
    },
    silentClose,
  };
}

/**
 * Start a responder for `adverts`. Returns `null` and opens no socket at all
 * when there is nothing to advertise (the loopback-default "no socket"
 * guarantee) — the factory is never even consulted in that case.
 */
export function startMdnsResponder(
  adverts: MdnsAdvertisement[],
  deps: { makeMdns?: MdnsFactory } = {},
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
    makeMdns?: MdnsFactory;
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
      const created = createResponder(adverts, { makeMdns: deps.makeMdns });
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
