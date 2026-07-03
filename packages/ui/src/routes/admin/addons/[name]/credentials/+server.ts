/**
 * GET  /admin/addons/:name/credentials — Return the addon's .env.schema as
 *   structured fields plus secret presence metadata.
 * POST /admin/addons/:name/credentials — Write supplied fields into
 *   knowledge/secrets/<ENV_KEY> (@sensitive) or knowledge/env/stack.env
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
import {
  jsonResponse,
  errorResponse,
  requireAdmin,
  getRequestId,
  parseJsonBody,
  jsonBodyError,
} from "$lib/server/helpers.js";
import {
  createLogger,
  getRegistryAddonConfig,
  listAvailableAddonIds,
  readStackSecretEnv,
  readStackEnv,
  writeStackSecretEnv,
  patchSecretsEnvFile,
} from "@openpalm/lib";

const logger = createLogger("addons.name.credentials");

type SchemaField = {
  key: string;
  sensitive: boolean;
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
 *   - `# ---` resets the accumulator (used as a section separator).
 *   - `KEY=DEFAULT` declares the field; default may be empty.
 */
function parseEnvSchema(text: string): SchemaField[] {
  const fields: SchemaField[] = [];
  let commentBuffer: string[] = [];
  let sensitive = false;

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
        continue;
      }
      if (body.startsWith("@")) {
        // Annotation line — may have multiple flags on one line
        // (e.g. `# @required @sensitive`). We only care about
        // @sensitive today; the rest are accepted but ignored.
        if (/\B@sensitive\b/.test(body)) sensitive = true;
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
      description: commentBuffer.join(" ").trim(),
      default: def,
    });
    commentBuffer = [];
    sensitive = false;
  }
  return fields;
}

export const GET: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
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
      description: f.description,
      default: f.default,
      set,
      secret: { envKey: f.key, present: set },
      value: "",
    };
  });

  return jsonResponse(200, { name, fields }, requestId);
};

export const POST: RequestHandler = async (event) => {
  const requestId = getRequestId(event);
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

  return jsonResponse(200, { ok: true, name, updated }, requestId);
};
