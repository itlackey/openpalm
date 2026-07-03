/**
 * Guardian /oc/* proxy drift guard — fail-closed startup assertion (design §5,
 * Stage 7).
 *
 * The /oc/* proxy IS the OpenCode API pinned to OPENCODE_VERSION. It couples to
 * OpenCode at exactly three pinned points (design §5):
 *   1. The allowlisted paths (§3.3)               — what the proxy may forward.
 *   2. `event.properties.sessionID` on session    — how /event fan-out filters
 *      events (§3.2).                                 (event-fanout.frameSessionId).
 *   3. The message/prompt_async prompt-body shape — what content moderation
 *      (`{ parts: [{ type, text }] }`, §3.5).         screens (proxy.extractPromptText).
 *
 * On guardian boot we fetch the assistant `/doc` (its live OpenAPI document) and
 * ASSERT those three couplings still exist. On drift OR fetch failure we DISABLE
 * the /oc/* route (it returns 503). This is fail-closed for the proxy, not
 * warning-only.
 *
 * Guardian-LOCAL on purpose (the assertion runs against the live assistant and
 * flips runtime state), mirroring rate-limit.ts / ownership.ts — NOT
 * @openpalm/lib. The PURE assertion (`assertDocCompatible`) takes a parsed doc so
 * it is trivially unit-testable; the fetch + state flip live here too but read no
 * shared control-plane code. The proxy's own allowlist is the source of truth for
 * which paths must exist, so this can never drift from the allowlist itself.
 */

import { OC_ALLOWLIST } from './oc-allowlist.ts';
import { createLogger } from './logger.ts';
import { ASSISTANT_URL } from './config.ts';

const logger = createLogger("guardian:drift");

const DRIFT_DOC_TIMEOUT_MS = Number(Bun.env.GUARDIAN_DRIFT_DOC_TIMEOUT_MS ?? 5_000);
const DRIFT_RETRY_MAX_ATTEMPTS = Number(Bun.env.GUARDIAN_DRIFT_RETRY_MAX_ATTEMPTS ?? 5);
const DRIFT_RETRY_INITIAL_MS = Number(Bun.env.GUARDIAN_DRIFT_RETRY_INITIAL_MS ?? 2_000);
const DRIFT_RETRY_MAX_MS = Number(Bun.env.GUARDIAN_DRIFT_RETRY_MAX_MS ?? 15_000);
const DRIFT_RECOVERY_INTERVAL_MS = Number(Bun.env.GUARDIAN_DRIFT_RECOVERY_INTERVAL_MS ?? 30_000);

// ── Runtime state: is the proxy enabled? ───────────────────────────────────
//
// Starts DISABLED (fail-closed). The boot-time check flips it on ONLY when the
// assistant /doc passes every assertion. server.ts reads isProxyEnabled() and
// returns 503 on the /oc/* route when it is false.

let proxyEnabled = false;

/** Whether the /oc/* proxy route is enabled (drift check passed). */
export function isProxyEnabled(): boolean {
  return proxyEnabled;
}

/** Test-only: force the proxy-enabled flag (so unit tests can assert both states). */
export function _setProxyEnabledForTest(value: boolean): void {
  proxyEnabled = value;
}

// ── Pure assertion over a parsed OpenAPI document ──────────────────────────

/** Result of asserting an assistant /doc is compatible with the proxy contract. */
export interface DriftCheckResult {
  ok: boolean;
  /** Human-readable reasons every failed assertion (empty when ok). */
  failures: string[];
}

/**
 * Pure: does this parsed OpenAPI document satisfy the three pinned couplings?
 *
 * Coupling 1 — allowlisted paths: every (method, template) in OC_ALLOWLIST must
 * appear in `doc.paths`. OpenAPI path keys use `{param}` placeholders whose names
 * may differ from our template names (e.g. our `/session/{id}` vs OpenCode's
 * `/session/{id}`), so we match STRUCTURALLY: literal segments equal, and any
 * `{…}` template segment matches any `{…}` doc segment. The method must be listed
 * under that path item (case-insensitive, as OpenAPI lower-cases method keys).
 *
 * Coupling 2 — `event.properties.sessionID`: the document must mention a
 * `sessionID` property somewhere in its event/permission schema surface. We do a
 * shallow-but-targeted scan of `components.schemas` for a `sessionID` property
 * key (the field the /event filter reads). Absence means the event nesting moved
 * and the fan-out filter would silently drop everything → fail closed.
 *
 * Coupling 3 — prompt-body `parts[].text`: the request body of a prompt-bearing
 * endpoint must accept a `parts` array of text parts. We assert a `parts`
 * property AND a `text` property exist somewhere in the schema surface (the shape
 * moderation extracts). Absence means moderation would screen "" and the upstream
 * shape changed → fail closed.
 *
 * Deterministic, no I/O. The caller supplies the already-parsed doc.
 */
export function assertDocCompatible(doc: unknown): DriftCheckResult {
  const failures: string[] = [];

  const paths = (doc as { paths?: unknown })?.paths;
  if (!paths || typeof paths !== "object") {
    failures.push("doc.paths missing or not an object");
    return { ok: false, failures };
  }
  const pathKeys = Object.keys(paths as Record<string, unknown>);

  // Coupling 1: every allowlisted (method, template) must exist in the doc.
  for (const route of OC_ALLOWLIST) {
    const matchKey = pathKeys.find((key) => pathTemplatesMatch(route.template, key));
    if (!matchKey) {
      failures.push(`allowlisted path missing from /doc: ${route.method} ${route.template}`);
      continue;
    }
    const item = (paths as Record<string, unknown>)[matchKey];
    if (!item || typeof item !== "object" || !(route.method.toLowerCase() in (item as Record<string, unknown>))) {
      failures.push(`allowlisted method missing from /doc: ${route.method} ${route.template} (matched ${matchKey})`);
    }
  }

  // Couplings 2 & 3: required property keys must appear in the schema surface.
  // A single recursive scan collects every property key name in the document
  // (schemas, requestBodies, responses). We only need to know the key EXISTS —
  // the live runtime is the real validator; this is a coarse drift tripwire.
  const propertyKeys = collectPropertyKeys(doc);
  if (!propertyKeys.has("sessionID")) {
    failures.push("event sessionID coupling drift: no `sessionID` property found in /doc (§3.2)");
  }
  if (!propertyKeys.has("parts")) {
    failures.push("prompt-body coupling drift: no `parts` property found in /doc (§3.5)");
  }
  if (!propertyKeys.has("text")) {
    failures.push("prompt-body coupling drift: no `text` property found in /doc (§3.5)");
  }

  return { ok: failures.length === 0, failures };
}

/**
 * Structural match of an allowlist template against an OpenAPI path key. Literal
 * segments must be equal; a `{…}` segment in EITHER matches a `{…}` segment in
 * the other (param names may differ). Same segment count required.
 */
function pathTemplatesMatch(template: string, docPath: string): boolean {
  const t = template.split("/");
  const d = docPath.split("/");
  if (t.length !== d.length) return false;
  for (let i = 0; i < t.length; i++) {
    const tParam = t[i].startsWith("{") && t[i].endsWith("}");
    const dParam = d[i].startsWith("{") && d[i].endsWith("}");
    if (tParam && dParam) continue; // both params → any name matches
    if (tParam !== dParam) return false; // one param, one literal → no match
    if (t[i] !== d[i]) return false; // both literal → must be equal
  }
  return true;
}

/**
 * Recursively collect every object KEY that lives under a `properties` object in
 * the document. Bounded by a depth cap so a pathological doc can't blow the
 * stack. We collect only property NAMES (cheap drift signal), not full schemas.
 */
function collectPropertyKeys(doc: unknown): Set<string> {
  const keys = new Set<string>();
  const seen = new Set<unknown>();

  function walk(node: unknown, depth: number): void {
    if (depth > 40 || node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const props = obj.properties;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      for (const k of Object.keys(props as Record<string, unknown>)) keys.add(k);
    }
    for (const v of Object.values(obj)) walk(v, depth + 1);
  }

  walk(doc, 0);
  return keys;
}

// ── Boot-time check: fetch /doc, assert, flip the flag ─────────────────────

/**
 * Fetch the assistant `/doc`, run the pure assertion, and ENABLE the proxy only
 * if it passes. On fetch failure, non-200, unparseable body, or any failed
 * assertion the proxy stays DISABLED (503) and a clear error is logged — the
 * buffered path is unaffected. Never throws (boot must not crash on this).
 *
 * Returns the final enabled state for the caller to log.
 */
export async function runDriftCheck(): Promise<boolean> {
  let doc: unknown;
  try {
    const headers = new Headers({ accept: "application/json" });
    const resp = await fetch(`${ASSISTANT_URL}/doc`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(DRIFT_DOC_TIMEOUT_MS),
    });
    if (!resp.ok) {
      proxyEnabled = false;
      logger.error("oc_proxy_disabled_drift", { reason: "doc_fetch_status", status: resp.status });
      return false;
    }
    doc = await resp.json();
  } catch (err) {
    proxyEnabled = false;
    logger.error("oc_proxy_disabled_drift", { reason: "doc_fetch_failed", error: String(err) });
    return false;
  }

  const result = assertDocCompatible(doc);
  if (!result.ok) {
    proxyEnabled = false;
    logger.error("oc_proxy_disabled_drift", { reason: "doc_incompatible", failures: result.failures });
    return false;
  }

  proxyEnabled = true;
  logger.info("oc_proxy_enabled", {});
  return true;
}

// ── Boot-time retry: backoff loop around runDriftCheck ─────────────────────

/**
 * Boot-time drift check with bounded retry + exponential backoff. Transient
 * fetch failures at boot (assistant briefly unreachable, Docker DNS not yet
 * resolved, /doc not yet served) no longer permanently disable the proxy.
 *
 * Retries up to DRIFT_RETRY_MAX_ATTEMPTS times with exponential backoff
 * (DRIFT_RETRY_INITIAL_MS doubling, capped at DRIFT_RETRY_MAX_MS). On first
 * success the proxy is enabled and the loop exits. On exhaustion the proxy
 * stays disabled — the caller should invoke startProxyRecovery() for ongoing
 * periodic recovery.
 *
 * Does NOT block the HTTP server from starting — the caller invokes this
 * fire-and-forget (void). /health remains always-200 regardless of outcome.
 *
 * The fail-closed property is preserved: a genuinely incompatible /doc (real
 * API drift) fails every assertion on every retry — the proxy stays disabled.
 * The retry only helps with transient fetch failures, not with drift.
 */
export async function runDriftCheckWithRetry(): Promise<boolean> {
  let delay = DRIFT_RETRY_INITIAL_MS;
  for (let attempt = 1; attempt <= DRIFT_RETRY_MAX_ATTEMPTS; attempt++) {
    const enabled = await runDriftCheck();
    if (enabled) return true;
    if (attempt >= DRIFT_RETRY_MAX_ATTEMPTS) {
      logger.error("oc_proxy_retry_exhausted", { attempts: attempt });
      return false;
    }
    logger.warn("oc_proxy_retry", { attempt, nextDelayMs: delay });
    await Bun.sleep(delay);
    delay = Math.min(delay * 2, DRIFT_RETRY_MAX_MS);
  }
  return false;
}

// ── Periodic recovery: re-check when the proxy is disabled ─────────────────

let recoveryTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start a periodic recovery check that re-runs runDriftCheck() while the proxy
 * remains disabled. This breaks the event-fanout retry deadlock: when the
 * proxy is disabled, /oc/event returns 503, so no event subscription can be
 * established and the event-fanout reconnect retry never fires. This interval
 * is independent of event subscribers and re-enables the proxy once the
 * assistant /doc is reachable and compatible.
 *
 * Idempotent: a no-op if the proxy is already enabled or a recovery timer is
 * already running. The interval is unref'd so it does not keep the process
 * alive. Cleared automatically on success or via stopProxyRecovery().
 */
export function startProxyRecovery(): void {
  if (recoveryTimer !== null) return;
  if (isProxyEnabled()) return;
  recoveryTimer = setInterval(() => {
    if (isProxyEnabled()) {
      stopProxyRecovery();
      return;
    }
    void runDriftCheck().then((enabled) => {
      if (enabled) stopProxyRecovery();
    });
  }, DRIFT_RECOVERY_INTERVAL_MS);
  recoveryTimer.unref();
  logger.info("oc_proxy_recovery_started", { intervalMs: DRIFT_RECOVERY_INTERVAL_MS });
}

/** Stop the periodic recovery check if one is running. */
export function stopProxyRecovery(): void {
  if (recoveryTimer !== null) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
    logger.info("oc_proxy_recovery_stopped", {});
  }
}

/** Test-only: stop recovery and reset state between test cases. */
export function _stopProxyRecoveryForTest(): void {
  stopProxyRecovery();
}
