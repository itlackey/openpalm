/**
 * GET  /api/host/addons/:name/credentials — Return the addon's .env.schema as
 *   structured fields plus secret presence metadata.
 * POST /api/host/addons/:name/credentials — Write supplied fields into
 *   knowledge/secrets/<ENV_KEY> (@sensitive) or state/stack.env
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
  getRegistryAddonConfig,
  listAvailableAddonIds,
  readStackSecretEnv,
  readStackEnv,
  reconcileRemoteAccess,
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
  // Sensitive fields live in knowledge/secrets/; non-sensitive in stack.env.
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
      // Every other field stays blank on GET (the drawer shows `default` as
      // a placeholder instead). A boolean checkbox can't work that way — an
      // unchecked box reads as "off", not "unset" — so it needs the actual
      // current value. Booleans are never @sensitive, so this never echoes
      // a secret back to the browser.
      value: f.boolean ? (set ? (stored as string) : f.default) : "",
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
    // stack.env by its own container at all: `tunnel` reads a GENERATED
    // Tailscale serve document, so persisting OP_REMOTE_TARGET/OP_REMOTE_PUBLIC
    // without regenerating that document would recreate the container below
    // only for it to re-read the previous config — a saved setting that
    // silently does nothing. Regenerate first, then let the recreate pick it
    // up. reconcileRemoteAccess never throws; it reports failure in its result.
    if (name === 'remote') {
      const remote = reconcileRemoteAccess(state.homeDir);
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
    }

    // Most schema keys are read by the addon container alone, so persisting them
    // IS the apply and the operator recreates that one container when ready.
    // A few reach further — see ADDON_ENV_RECREATE_SCOPE — and for those a write
    // with no apply is a setting that silently does nothing. Recreate exactly
    // the services the key reaches, under the lock we already hold, so compose
    // rebuilds its file list and the affected entrypoints re-read the value.
    const scope = [
      ...new Set(updated.flatMap((key) => ADDON_ENV_RECREATE_SCOPE[key] ?? [])),
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

    return jsonResponse(200, { ok: true, name, updated, recreated }, requestId);
  });
};
