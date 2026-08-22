/**
 * GET  /api/host/addons/:name/credentials — Return the addon's .env.schema as
 *   structured fields plus secret presence metadata.
 * POST /api/host/addons/:name/credentials — Write supplied fields into
 *   state/secrets/<ENV_KEY> (@sensitive) or state/stack.env
 *   (non-sensitive). Split determined by `# @sensitive` schema annotation.
 *   Body shape: { values: { KEY: VALUE | "" } }. Empty strings clear the key.
 *
 * Sensitive addon credentials (bot tokens, API keys) stay as file-backed
 * compose secrets. Non-sensitive config (allowed guilds, model names, etc.)
 * goes to stack.env so it is visible to `docker compose config` and is not
 * treated as a secret by compose.
 */
import type { RequestHandler } from "./$types";
import { getState } from "$lib/server/state.js";
import { withAdminUpdateLock } from '$lib/server/admin-update-lock.js';
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  requireCapability,
  getRequestId,
  parseJsonBody,
  jsonBodyError,
} from "$lib/server/helpers.js";
import {
  ADDON_ENV_RECREATE_SCOPE,
  activateStack,
  createLogger,
  getAddonProfiles,
  getAddonProfileSelection,
  getAddonServiceNames,
  getRegistryAddonConfig,
  listAvailableAddonIds,
  readStackSecretEnv,
  readStackEnv,
  applyRemoteProviderConfig,
  reconcileGuardianDeployment,
  writeStackSecretEnv,
  patchSecretsEnvFile,
} from "@openpalm/lib";

const logger = createLogger("addons.name.credentials");

type SchemaField = {
  key: string;
  sensitive: boolean;
  boolean: boolean;
  description: string;
  default: string;
};

/**
 * Parse a `.env.schema` file into structured fields.
 *
 * Schema conventions:
 *   - Lines starting with `#` are comments; consecutive comment lines
 *     accumulate as the *description* of the next KEY=VALUE line.
 *   - `# @sensitive` marks the next field as sensitive (renders as a
 *     password input and is masked on GET).
 *   - `# @boolean` marks the next field as a true/false toggle (renders as
 *     a checkbox, writing the literal strings "true"/"false" — a text box
 *     you'd have to type "true" into is not "easy to toggle").
 *   - `# ---` resets the accumulator (used as a section separator).
 *   - `KEY=DEFAULT` declares the field; default may be empty.
 */
function parseEnvSchema(text: string): SchemaField[] {
  const fields: SchemaField[] = [];
  let commentBuffer: string[] = [];
  let sensitive = false;
  let bool = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      // Blank line: keep the comment buffer (multi-line descriptions
      // sometimes have blank lines between paragraphs in our schemas).
      continue;
    }
    if (line.startsWith("#")) {
      const body = line.slice(1).trim();
      if (body === "---") {
        commentBuffer = [];
        sensitive = false;
        bool = false;
        continue;
      }
      if (body.startsWith("@")) {
        // Annotation line — may have multiple flags on one line
        // (e.g. `# @required @sensitive`). We only care about
        // @sensitive/@boolean today; the rest are accepted but ignored.
        if (/\B@sensitive\b/.test(body)) sensitive = true;
        if (/\B@boolean\b/.test(body)) bool = true;
        continue;
      }
      commentBuffer.push(body);
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    const def = line.slice(eq + 1).trim();
    fields.push({
      key,
      sensitive,
      boolean: bool,
      description: commentBuffer.join(" ").trim(),
      default: def,
    });
    commentBuffer = [];
    sensitive = false;
    bool = false;
  }
  return fields;
}

/**
 * ADDON_ENV_RECREATE_SCOPE names the voice service by its CPU-profile compose
 * name ("voice"), but the CUDA/ROCm hardware profiles deploy "voice-cuda"/
 * "voice-rocm" instead — recreating "voice" there touches only the
 * inactive-profile service and the running GPU container never picks up the
 * change. Translate through the addon's profile catalog using the persisted
 * OP_VOICE_PROFILE selection (same resolution voice/bring-up.ts uses).
 */
function resolveVoiceScopeService(homeDir: string, service: string): string {
  if (service !== "voice") return service;
  const selected = getAddonProfileSelection(homeDir, "voice");
  if (!selected) return service;
  const services = getAddonProfiles(homeDir, "voice").find((p) => p.id === selected)?.services;
  return services?.[0] ?? service;
}

/**
 * The addon's OWN container, resolved to the variant that is actually
 * selected, or nothing when the addon has no container of its own.
 *
 * Deliberately one service, not the addon's whole declared set:
 * `getAddonServiceNames('voice')` returns every variant (`voice`,
 * `voice-cuda`, `voice-rocm`) because all three are declared under different
 * profiles, and recreating all of them targets two services that are not up.
 * The declared set is still consulted, so a name is never invented for an
 * addon that has no container (`api` — the guardian serves that edge).
 */
function addonOwnServices(homeDir: string, name: string): string[] {
  const resolved = resolveVoiceScopeService(homeDir, name);
  return getAddonServiceNames(homeDir, name).includes(resolved) ? [resolved] : [];
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:addons', requestId);
  if (capabilityError) return capabilityError;
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const name = event.params.name;

  if (!listAvailableAddonIds().includes(name)) {
    return errorResponse(404, "not_found", `Addon "${name}" is not available`, { name }, requestId);
  }

  let config: ReturnType<typeof getRegistryAddonConfig>;
  try {
    config = getRegistryAddonConfig(name);
  } catch (error) {
    logger.error("schema read failed", { name, error: String(error), requestId });
    return errorResponse(500, "internal_error", `Addon "${name}" schema is unavailable`, {}, requestId);
  }

  const schemaFields = parseEnvSchema(config.envSchema);
  // Sensitive fields live in state/secrets/; non-sensitive in stack.env.
  const secretEnv = readStackSecretEnv(state.homeDir);
  const stackEnv = readStackEnv(state.homeDir);

  const fields = schemaFields.map((f) => {
    const stored = f.sensitive ? secretEnv[f.key] : stackEnv[f.key];
    const set = (stored ?? "").length > 0;
    return {
      key: f.key,
      sensitive: f.sensitive,
      boolean: f.boolean,
      description: f.description,
      default: f.default,
      set,
      secret: { envKey: f.key, present: set },
      // A field that IS set round-trips its current value; @sensitive ones
      // never do (that would put a stored secret in the browser's DOM).
      //
      // Set fields used to come back blank, with the drawer showing `default`
      // as a placeholder. That silently destroyed data: the drawer seeds its
      // form from this response and POSTs every non-sensitive field,
      // deliberately including empty ones so a value CAN be cleared — so
      // editing one field wrote "" over every other field the operator never
      // touched. Harmless-looking for a display name; not for `remote`, where
      // blanking OP_REMOTE_TARGET silently re-points a live tunnel back to the
      // assistant and blanking OP_REMOTE_HOSTNAME un-pins the write-once
      // tailnet name, moving the operator's public URL. Returning the real
      // value is what makes "submit everything" a faithful round-trip.
      //
      // UNSET fields stay blank rather than pre-filling `default`, so a save
      // does not materialize every schema default into stack.env as an
      // explicit setting. The exception is a boolean: an unchecked box reads
      // as "off", not "unset", so a checkbox needs a concrete value to render.
      value: f.sensitive ? "" : set ? (stored as string) : f.boolean ? f.default : "",
    };
  });

  return jsonResponse(200, { name, fields }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
  const capabilityError = requireCapability(event, 'host:addons', requestId);
  if (capabilityError) return capabilityError;
  const authErr = requireAdmin(event, requestId);
  if (authErr) return authErr;

  const state = getState();
  const name = event.params.name;

  if (!listAvailableAddonIds().includes(name)) {
    return errorResponse(404, "not_found", `Addon "${name}" is not available`, { name }, requestId);
  }

  const parsed = await parseJsonBody(event.request);
  if ("error" in parsed) return jsonBodyError(parsed, requestId);
  const valuesRaw = (parsed.data.values as Record<string, unknown> | undefined) ?? {};

  let config: ReturnType<typeof getRegistryAddonConfig>;
  try {
    config = getRegistryAddonConfig(name);
  } catch (error) {
    logger.error("schema read failed (post)", { name, error: String(error), requestId });
    return errorResponse(500, "internal_error", `Addon "${name}" schema is unavailable`, {}, requestId);
  }
  const schemaFields = parseEnvSchema(config.envSchema);
  const sensitiveKeys = new Set(schemaFields.filter((f) => f.sensitive).map((f) => f.key));
  const allowedKeys = new Set(schemaFields.map((f) => f.key));

  // Only accept keys declared in the schema; silently drop anything else.
  // Split by @sensitive annotation: sensitive fields → compose secret files;
  // non-sensitive fields → stack.env (visible to `docker compose config`).
  const sensitiveUpdates: Record<string, string> = {};
  const configUpdates: Record<string, string> = {};
  for (const [k, v] of Object.entries(valuesRaw)) {
    if (!allowedKeys.has(k)) continue;
    const val = typeof v === "string" ? v : "";
    if (sensitiveKeys.has(k)) {
      sensitiveUpdates[k] = val;
    } else {
      configUpdates[k] = val;
    }
  }

  if (Object.keys(sensitiveUpdates).length === 0 && Object.keys(configUpdates).length === 0) {
    return errorResponse(400, "bad_request", "no schema-declared keys supplied", {}, requestId);
  }

  return withAdminUpdateLock(state, requestId, async (lock) => {
    // Snapshot the stored values BEFORE writing: the recreate scope below must
    // derive from keys whose value actually CHANGED, not keys merely written —
    // the drawer POSTs every non-sensitive field on every save, so a
    // write-derived scope force-recreated voice+assistant (killing live
    // sessions) even when OP_VOICE_LAN_ACCESS was round-tripped unchanged.
    const priorSecretEnv = readStackSecretEnv(state.homeDir);
    const priorStackEnv = readStackEnv(state.homeDir);
    const changedKeys = [
      ...Object.keys(sensitiveUpdates).filter((k) => sensitiveUpdates[k] !== (priorSecretEnv[k] ?? "")),
      ...Object.keys(configUpdates).filter((k) => configUpdates[k] !== (priorStackEnv[k] ?? "")),
    ].sort();

    try {
      if (Object.keys(sensitiveUpdates).length > 0) {
        writeStackSecretEnv(state, sensitiveUpdates);
      }
      if (Object.keys(configUpdates).length > 0) {
        patchSecretsEnvFile(state.homeDir, configUpdates);
      }
    } catch (err) {
      logger.error("write failed", { name, error: String(err), requestId });
      return errorResponse(500, "internal_error", err instanceof Error ? err.message : "write failed", {}, requestId);
    }

    const updated = [...Object.keys(sensitiveUpdates), ...Object.keys(configUpdates)].sort();

    // The `remote` addon is the one built-in whose config is not read from
    // stack.env by its own container at all: its providers serve GENERATED
    // artifacts (the Tailscale variant's serve document today), so persisting
    // OP_REMOTE_TARGET/OP_REMOTE_PUBLIC without regenerating them would
    // recreate the container below only for it to re-read the previous
    // config — a saved setting that silently does nothing. Regenerate first,
    // then let the recreate pick it up. Which provider's apply runs is the
    // registry dispatch's job (applyRemoteProviderConfig); it never throws
    // and reports failure in its result.
    //
    // The dispatch runs the FULL provider apply, not a bare artifact
    // reconcile: changing OP_REMOTE_TARGET to guardian/both also requires
    // GUARDIAN_DIRECT_INGRESS to be "true" and the guardian recreated, or
    // the freshly generated proxy points at the guardian's 404-disabled
    // direct listener. The provider apply owns both halves and reports which
    // services that implies.
    let remoteServices: string[] = [];
    if (name === 'remote') {
      const remote = applyRemoteProviderConfig(state.homeDir);
      if (remote.error) {
        logger.error('serve config write failed', { name, error: remote.error, requestId });
        return errorResponse(
          500,
          'internal_error',
          `Saved, but the remote access config could not be written: ${remote.error}`,
          { updated },
          requestId,
        );
      }
      remoteServices = remote.services;
    }

    // A save is an APPLY. Every schema key reaches its container through
    // Compose interpolation or a Compose secret, both of which are fixed at
    // container-CREATE time — so the addon's own services are recreated
    // whenever a key actually changed.
    //
    // This used to stop at ADDON_ENV_RECREATE_SCOPE, a table of the four keys
    // that reach OTHER services, on the reasoning that a key read by the addon
    // alone is applied by "the operator recreating that one container when
    // ready". There is no such affordance: Containers offers start / stop /
    // restart, and `compose restart` reuses the existing env, ports and
    // secrets. So rotating a Discord token, narrowing DISCORD_ALLOWED_GUILDS,
    // or moving OP_PAPERCLIP_PORT wrote to disk, reported success, and left
    // the old value serving — the leaked token still authenticating, the port
    // still on its old number. The table now answers only "which OTHER
    // services does this key reach"; the addon's own services are implied.
    const scope = [
      ...new Set([
        // The remote apply owns the complete scope for remote saves. The
        // schema table cannot express that a disabled remote addon must not
        // recreate `tunnel`, or that a guardian recreate depends on ingress
        // state. Other addons still use their schema-declared scope.
        ...(name === 'remote'
          ? []
          : [
              ...(changedKeys.length > 0 ? addonOwnServices(state.homeDir, name) : []),
              ...changedKeys.flatMap((key) =>
                (ADDON_ENV_RECREATE_SCOPE[key] ?? []).map((svc) => resolveVoiceScopeService(state.homeDir, svc)),
              ),
            ]),
        ...remoteServices,
      ]),
    ];
    let recreated: string[] = [];
    if (scope.length > 0) {
      // activateStack THROWS on a config-resolution failure (no docker binary, an
      // unparseable overlay) and only RETURNS ok:false for a failed up — both are
      // the same outcome to the operator, so catch as well as check. Mirrors
      // applyAccessToggles, which wraps its recreate for exactly this reason.
      let detail: string | undefined;
      try {
        const result = await activateStack(state, { kind: 'services', services: scope }, {}, { lock });
        recreated = result.started;
        if (!result.ok) {
          detail = result.error
            || result.failed.map((entry) => `${entry.service}: ${entry.reason}`).join('; ')
            || 'compose apply failed';
        }
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }
      if (detail) {
        logger.error('apply failed', { name, error: detail, requestId });
        return errorResponse(
          500,
          'addon_env_apply_failed',
          `Saved, but the change could not be applied: ${detail}. Run \`openpalm start\` to retry.`,
          { updated, recreated },
          requestId,
        );
      }
    }

    // A remote save can move the guardian's LAST deploy reason (target off the
    // guardian, with no ingress addon or toggle left): the apply above
    // deliberately leaves the guardian out of its recreate scope in that case
    // — recreating a service whose profile just went inactive is the wrong
    // verb — and this reconcile is what actually stops it (or starts one a
    // target change just made required). Logged, never fatal: the save landed.
    if (name === 'remote') {
      const reconcile = await reconcileGuardianDeployment(state, { lock });
      if (!reconcile.ok) {
        logger.warn('guardian reconcile after remote save failed', {
          error: reconcile.error,
          requestId,
        });
      } else if (reconcile.action !== 'none') {
        logger.info(`guardian ${reconcile.action} after remote save`, { requestId });
      }
    }

    return jsonResponse(
      200,
      { ok: true, name, updated, recreated },
      requestId,
    );
  });
};
