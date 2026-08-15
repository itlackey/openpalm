/**
 * Remote access (`remote` addon) — Tailscale-backed reachability for the
 * assistant and/or guardian from outside the home network.
 *
 * This module owns the CONFIG MODEL and the derivation of Tailscale's own
 * `ipn.ServeConfig` document from it. It does not write compose files, mount
 * secrets, or touch the network-access toggles in access-toggles.ts — those
 * are a published front door on the LAN, this is a published front door on
 * the tailnet (and, optionally, the public internet), and the two compose
 * independently: an operator can enable `remote` for guardian-only exposure
 * while assistantDirect stays off.
 *
 * Browser-safe: no `node:*` imports. The setup wizard imports this directly
 * via the `@openpalm/lib/control-plane/remote-access.js` subpath, exactly
 * like access-toggles.ts.
 */

// ── The model ─────────────────────────────────────────────────────────────

export type RemoteAccessConfig = {
  /** Pinned tailnet node name. Empty string means "derive from OP_PROJECT_NAME". */
  hostname: string;
  /** false = Tailscale Serve (only the operator's own signed-in devices). true = Tailscale Funnel (public internet). */
  public: boolean;
  /** Which service(s) the tunnel exposes. */
  target: "assistant" | "guardian" | "both";
};

/** Private and pointed at the assistant only — the safe default for a fresh install. */
export const REMOTE_ACCESS_DEFAULTS: RemoteAccessConfig = {
  hostname: "",
  public: false,
  target: "assistant",
};

export const REMOTE_TARGETS = ["assistant", "guardian", "both"] as const;
export type RemoteTarget = (typeof REMOTE_TARGETS)[number];

// ── Hostname derivation ──────────────────────────────────────────────────

/**
 * Turn a compose project name into a valid Tailscale machine name (a DNS
 * label): lowercase, non-`[a-z0-9-]` characters become `-`, runs of `-`
 * collapse to one, leading/trailing `-` are stripped, and the result is
 * truncated to 63 characters (the DNS label limit) with a re-strip in case
 * truncation lands on a hyphen.
 *
 * WHY THIS MATTERS: if two stacks on one host both register as "openpalm",
 * Tailscale permanently appends "-1" to the second node's name — and that
 * suffix survives even after the original registration goes away, so the
 * collision leaves a lasting mark. If the control plane assumed the plain
 * name, the UI would advertise a URL ("https://openpalm.tailXXXX.ts.net")
 * that does not exist. Deriving the hostname from the compose PROJECT name —
 * which Docker already forces to be unique per host — makes multi-stack
 * hostnames collision-free by construction, with no coordination required.
 */
export function deriveRemoteHostname(projectName: string): string {
  const lowered = projectName.trim().toLowerCase();
  const mapped = lowered.replace(/[^a-z0-9-]/g, "-");
  const collapsed = mapped.replace(/-+/g, "-");
  const stripped = collapsed.replace(/^-+|-+$/g, "");
  const truncated = stripped.slice(0, 63).replace(/-+$/g, "");
  return truncated || "openpalm";
}

/**
 * Resolve the EFFECTIVE tailnet hostname: the pinned value when one is
 * stored, otherwise derived from the compose project name.
 *
 * WHY: a PINNED hostname is what makes a later project rename safe. The
 * tailnet node name is baked into the operator's public URL and into every
 * bookmark and QR code they made from it; re-deriving it on every apply
 * would mean renaming the stack silently moves the URL out from under them
 * and strands the old registration on the tailnet. Pinning once — at first
 * registration — and reading the pin back thereafter is the fix. (Writing
 * the pin is a later batch's job; this function only has to prefer it when
 * present.)
 */
export function resolveRemoteHostname(env: Record<string, string | undefined>): string {
  const pinned = env.OP_REMOTE_HOSTNAME?.trim();
  if (pinned) return pinned;
  return deriveRemoteHostname(env.OP_PROJECT_NAME?.trim() || "openpalm");
}

// ── Reading / writing config ─────────────────────────────────────────────

const TRUE_RE = /^(true|1|yes|on)$/i;

function parseRemoteTarget(raw: string | undefined): RemoteTarget {
  // An absent or blank key is the safe default — the credentials drawer
  // round-trips unset fields as "" and persists `OP_REMOTE_TARGET=` verbatim,
  // which must read back as "unset" (mirroring resolveRemoteHostname's blank
  // handling). An explicitly present invalid value is rejected instead of
  // being normalized to assistant, which could turn a public typo into an
  // unintended assistant exposure.
  if (raw === undefined || raw.trim() === "") return REMOTE_ACCESS_DEFAULTS.target;

  const trimmed = raw.trim();
  if ((REMOTE_TARGETS as readonly string[]).includes(trimmed)) {
    return trimmed as RemoteTarget;
  }

  throw new Error(
    `Invalid OP_REMOTE_TARGET; expected one of: ${REMOTE_TARGETS.join(", ")}.`,
  );
}

/** Read the addon's config back out of an env record (state/stack.env). */
export function readRemoteAccessConfig(env: Record<string, string | undefined>): RemoteAccessConfig {
  return {
    hostname: resolveRemoteHostname(env),
    public: TRUE_RE.test(env.OP_REMOTE_PUBLIC?.trim() ?? ""),
    target: parseRemoteTarget(env.OP_REMOTE_TARGET),
  };
}

/** Narrow arbitrary JSON to a complete config, defaulting anything absent or wrong-typed. */
export function coerceRemoteAccessConfig(value: unknown): RemoteAccessConfig {
  const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const result = { ...REMOTE_ACCESS_DEFAULTS };
  if (typeof source.hostname === "string") result.hostname = source.hostname;
  if (typeof source.public === "boolean") result.public = source.public;
  if (
    typeof source.target === "string"
    && (REMOTE_TARGETS as readonly string[]).includes(source.target)
  ) {
    result.target = source.target as RemoteTarget;
  }
  return result;
}

/**
 * Serialize a config back to its `OP_REMOTE_*` env keys. Must round-trip with
 * {@link readRemoteAccessConfig} — `TS_AUTHKEY` is deliberately absent here:
 * it is `@sensitive` and is routed to a secret file, never to stack.env.
 *
 * CAUTION on `hostname`: the round trip is deliberately ASYMMETRIC.
 * `readRemoteAccessConfig` never returns an empty hostname — it resolves the
 * pinned-or-derived value — so feeding its output straight back through this
 * function emits a NON-empty `OP_REMOTE_HOSTNAME` even for an install that
 * has never pinned one, silently converting a derived value into a permanent
 * pin behind `pinRemoteHostname`'s back. `pinRemoteHostname` (remote-apply.ts)
 * is the single writer of that key, and it is write-once precisely so a later
 * project rename cannot move the operator's public URL. A caller persisting
 * user-edited config should write only the keys the user actually changed, or
 * drop `OP_REMOTE_HOSTNAME` from this result when the operator left the field
 * blank.
 */
export function resolveRemoteEnv(cfg: RemoteAccessConfig): Record<string, string> {
  return {
    OP_REMOTE_HOSTNAME: cfg.hostname,
    OP_REMOTE_PUBLIC: cfg.public ? "true" : "false",
    OP_REMOTE_TARGET: cfg.target,
  };
}

// ── ServeConfig derivation ───────────────────────────────────────────────

// Browser-safe: network-contract.ts imports only the constant table in
// defaults.ts, so pulling the workspace default in keeps this module free of
// `node:*` exactly as its header promises.
import { DEFAULT_WORKSPACE_PORT } from "./network-contract.js";

type ServeHandler = { Proxy: string };
type ServeWebConfig = { Handlers: Record<string, ServeHandler> };

/**
 * Tailscale's `ipn.ServeConfig` document (the subset containerboot's
 * `TS_SERVE_CONFIG` consumes), keyed by port. See
 * https://github.com/tailscale/tailscale/blob/main/ipn/serve.go
 */
export type ServeConfigDoc = {
  TCP: Record<string, { HTTPS: true }>;
  Web: Record<string, ServeWebConfig>;
  AllowFunnel: Record<string, boolean>;
};

/** One published door: a tailnet port, what it proxies, and whether it may funnel. */
type ServeEndpoint = { port: number; proxy: string; funnelable: boolean };

/**
 * PORT ASSIGNMENT — stable per service, so a target change never moves an
 * existing URL. assistant is always 443, guardian is always 8443 (the pair
 * docs/remote-access-tls.md documents for these two services). Ports are
 * NOT reassigned based on which targets are active, so bookmarking
 * "https://host.ts.net:8443" for the guardian keeps working even if the
 * operator later also turns on the assistant.
 *
 * Exposing the assistant opens TWO doors, which is why a target maps to a LIST.
 * OpenCode's web UI is a root-mounted SPA, so `/advanced` frames it at an origin
 * of its own rather than a path (see the UI's workspace-listener.ts), and the
 * browser composes that origin from the page it is on plus one port number.
 * Publishing the workspace on the SAME number the stack publishes locally is
 * what lets a single advertised port be correct for every client, however it
 * arrived.
 *
 * `funnelable` is a property of the door, not of the request to open it: the
 * workspace is served but never funneled. Tailscale allows Funnel on
 * 443/8443/10000 only, and a port whose whole job is handing out a shell
 * belongs on the operator's own tailnet regardless.
 */
function endpointsFor(
  name: "assistant" | "guardian",
  workspacePort: number | null,
): ServeEndpoint[] {
  if (name === "guardian") {
    return [{ port: 8443, proxy: "http://guardian:3830", funnelable: true }];
  }
  const doors: ServeEndpoint[] = [
    { port: 443, proxy: "http://assistant:3000", funnelable: true },
  ];
  // `null` means the operator turned the workspace listener off; publishing a
  // tailnet port for a listener nothing binds is the failure this avoids.
  if (workspacePort !== null) {
    doors.push({
      port: workspacePort,
      proxy: `http://assistant:${workspacePort}`,
      funnelable: false,
    });
  }
  return doors;
}

function targetsFor(target: RemoteTarget): ("assistant" | "guardian")[] {
  if (target === "both") return ["assistant", "guardian"];
  return [target];
}

/**
 * Derive Tailscale's `ipn.ServeConfig` JSON document from the addon config.
 *
 * The literal string `${TS_CERT_DOMAIN}` appears verbatim in the emitted
 * `Web` and `AllowFunnel` keys — containerboot substitutes the node's real
 * FQDN at read time, so the control plane never has to learn (or race) the
 * assigned tailnet hostname just to write this file.
 *
 * `AllowFunnel` keys are ALWAYS present with an explicit boolean, even when
 * `cfg.public` is false. Tailscale's `readServeConfig` treats a missing or
 * empty file as "no change" and the watch loop skips it — so implementing
 * "turn public access off" by omitting the key (or deleting the file) would
 * leave a previously-funneled service exposed to the public internet
 * indefinitely. Writing an explicit `false` is what actually closes the
 * door.
 *
 * Keys are emitted in ascending port order so the generated file does not
 * churn between writes with no configuration change.
 *
 * `workspacePort` is `null` when the operator turned the workspace listener
 * off — distinct from omitting the argument, which takes the default. A plain
 * optional-with-default cannot express that: passing `undefined` explicitly
 * fires the default, so "off" would silently republish the default port.
 * See {@link endpointsFor} for which doors a target opens.
 */
export function resolveServeConfig(
  cfg: RemoteAccessConfig,
  workspacePort: number | null = DEFAULT_WORKSPACE_PORT,
): ServeConfigDoc {
  const endpoints = targetsFor(cfg.target)
    .flatMap((name) => endpointsFor(name, workspacePort))
    .sort((a, b) => a.port - b.port);

  const TCP: ServeConfigDoc["TCP"] = {};
  const Web: ServeConfigDoc["Web"] = {};
  const AllowFunnel: ServeConfigDoc["AllowFunnel"] = {};

  for (const { port, proxy, funnelable } of endpoints) {
    TCP[String(port)] = { HTTPS: true };
    Web[`\${TS_CERT_DOMAIN}:${port}`] = { Handlers: { "/": { Proxy: proxy } } };
    AllowFunnel[`\${TS_CERT_DOMAIN}:${port}`] = funnelable && cfg.public;
  }

  return { TCP, Web, AllowFunnel };
}

// ── Operator-facing exposure summary ─────────────────────────────────────

/**
 * One plain-language line per opened door, for the startup log and the
 * admin surface. Mirrors `describeAccessExposure` in access-toggles.ts:
 * exposure is reported as a fact about config the operator set, not
 * diagnosed as possible drift. Returns `[]` when the addon is disabled —
 * an addon that is off opens nothing, regardless of what its config says.
 *
 * Deliberately reports a PORT, never a URL. `cfg.hostname` is only the node
 * label ("openpalm"); the address a person can actually open is
 * `https://<hostname>.<tailnet>.ts.net`, and the tailnet suffix is assigned
 * by Tailscale at registration — it is not derivable from configuration and
 * is not known at all until the node has joined. Interpolating the bare label
 * into a `https://…` string would print an address that does not resolve.
 * The real URL is observed state, read back from the running tunnel, and it
 * is surfaced only once the tunnel reports up — the same "advertise LAST"
 * invariant applyAccessToggles already enforces for mDNS names.
 */
export function describeRemoteExposure(
  cfg: RemoteAccessConfig,
  enabled: boolean,
  workspacePort: number | null = DEFAULT_WORKSPACE_PORT,
): string[] {
  if (!enabled) return [];
  const lines: string[] = [];
  const funneled = "the public internet — anyone who has the address, with no sign-in of their own";
  const tailnet = "your own signed-in devices, over your private tailnet";
  for (const name of targetsFor(cfg.target)) {
    for (const door of endpointsFor(name, workspacePort)) {
      // One line per DOOR, not per target: exposing the assistant also
      // publishes OpenCode's workspace, and an operator reading "the assistant
      // is reachable" would not otherwise learn that a second port carrying a
      // terminal went up with it.
      const what = door.port === workspacePort ? `${name} workspace` : name;
      const reach = door.funnelable && cfg.public ? funneled : tailnet;
      lines.push(
        `The ${what} is reachable from outside this network on port `
          + `${door.port}, from ${reach}.`,
      );
    }
  }
  return lines;
}
