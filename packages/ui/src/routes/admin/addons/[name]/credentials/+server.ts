/**
 * GET  /admin/addons/:name/credentials — Return the addon's .env.schema as
 *   structured fields plus the current value of each from stack.env.
 *   Sensitive values are masked (returned as boolean `set` flag, not the
 *   raw value).
 * POST /admin/addons/:name/credentials — Write supplied fields into stack.env.
 *   Body shape: { values: { KEY: VALUE | "" } }. Empty strings clear the key.
 *
 * Addon credentials (Discord/Slack bot tokens, channel HMAC secrets, etc.)
 * are read by the channel containers via compose `--env-file=stack.env`,
 * so this endpoint is the post-install replacement for the wizard-only
 * credential entry path.
 */
import type { RequestHandler } from "./$types";
import { existsSync, readFileSync } from "node:fs";
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
  parseEnvContent,
  updateSecretsEnv,
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

function readStackEnv(stackDir: string): Record<string, string> {
  const path = `${stackDir}/stack.env`;
  if (!existsSync(path)) return {};
  try {
    return parseEnvContent(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
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

  let config;
  try {
    config = getRegistryAddonConfig(state.homeDir, name);
  } catch (error) {
    logger.error("schema read failed", { name, error: String(error), requestId });
    return errorResponse(500, "internal_error", `Addon "${name}" schema is unavailable`, {}, requestId);
  }

  const schemaFields = parseEnvSchema(config.envSchema);
  const stackEnv = readStackEnv(state.stackDir);

  const fields = schemaFields.map((f) => {
    const set = (stackEnv[f.key] ?? "").length > 0;
    return {
      key: f.key,
      sensitive: f.sensitive,
      description: f.description,
      default: f.default,
      set,
      // Non-sensitive values are returned as-is so the form can show
      // them; sensitive values stay masked (caller sees `set: true`).
      value: f.sensitive ? "" : (stackEnv[f.key] ?? ""),
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

  let config;
  try {
    config = getRegistryAddonConfig(state.homeDir, name);
  } catch (error) {
    logger.error("schema read failed (post)", { name, error: String(error), requestId });
    return errorResponse(500, "internal_error", `Addon "${name}" schema is unavailable`, {}, requestId);
  }
  const allowedKeys = new Set(parseEnvSchema(config.envSchema).map((f) => f.key));

  // Only accept keys declared in the schema; silently drop anything else
  // so a malicious caller can't smuggle arbitrary env vars into stack.env
  // through this endpoint.
  const updates: Record<string, string> = {};
  for (const [k, v] of Object.entries(valuesRaw)) {
    if (!allowedKeys.has(k)) continue;
    updates[k] = typeof v === "string" ? v : "";
  }

  if (Object.keys(updates).length === 0) {
    return errorResponse(400, "bad_request", "no schema-declared keys supplied", {}, requestId);
  }

  try {
    updateSecretsEnv(state, updates);
  } catch (err) {
    logger.error("write failed", { name, error: String(err), requestId });
    return errorResponse(500, "internal_error", err instanceof Error ? err.message : "write failed", {}, requestId);
  }

  return jsonResponse(200, { ok: true, name, updated: Object.keys(updates).sort() }, requestId);
};
