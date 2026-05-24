/**
 * One-shot migration: rename unprefixed voice keys (TTS_BASE_URL,
 * STT_BASE_URL, …) in stack.env to the OP_-prefixed form
 * (OP_TTS_BASE_URL, OP_STT_BASE_URL, …).
 *
 * Pre-rename the UI server read these unprefixed names directly from
 * process.env, which let unrelated shell env vars (OpenAI clients,
 * kokoro-fastapi, etc.) silently override the saved Voice settings.
 * Renaming to OP_-prefixed names eliminates that collision class.
 *
 * Migration is idempotent: only keys that exist without the prefix and
 * have no prefixed counterpart are renamed; everything else is left
 * alone. If neither form is present the file isn't touched.
 *
 * Called from ensureSecrets after migrateAuth0110 so the renamed values
 * land in stack.env before hooks.server.ts promotes them into process.env.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseEnvContent, removeEnvKey, upsertEnvValue } from "./env.js";
import { migration0110LogPath } from "./paths.js";
import type { ControlPlaneState } from "./types.js";

const VOICE_KEYS = [
  "TTS_ENGINE", "TTS_PROVIDER", "TTS_BASE_URL", "TTS_MODEL", "TTS_VOICE", "TTS_API_KEY",
  "STT_ENGINE", "STT_PROVIDER", "STT_BASE_URL", "STT_MODEL", "STT_LANGUAGE", "STT_API_KEY",
] as const;

export type MigrateVoiceVarsResult = {
  migrated: boolean;
  reason: string;
};

export function migrateVoiceVars(state: ControlPlaneState): MigrateVoiceVarsResult {
  const stackEnvPath = `${state.stackDir}/stack.env`;
  if (!existsSync(stackEnvPath)) {
    return { migrated: false, reason: "no stack.env yet (fresh install)" };
  }

  const before = readFileSync(stackEnvPath, "utf-8");
  const parsed = parseEnvContent(before);

  let content = before;
  const renamed: string[] = [];
  for (const key of VOICE_KEYS) {
    const prefixed = `OP_${key}`;
    const hasUnprefixed = key in parsed;
    const hasPrefixed = prefixed in parsed;
    if (!hasUnprefixed) continue;
    if (hasPrefixed) {
      // Operator (or a prior partial migration) already set the
      // prefixed form. Drop the unprefixed duplicate; prefixed wins.
      content = removeEnvKey(content, key);
      renamed.push(`dropped ${key} (${prefixed} already set)`);
      continue;
    }
    const value = parsed[key];
    if (typeof value !== "string") continue;
    content = upsertEnvValue(content, prefixed, value);
    content = removeEnvKey(content, key);
    renamed.push(`${key} → ${prefixed}`);
  }

  if (renamed.length === 0) {
    return { migrated: false, reason: "no unprefixed voice keys present" };
  }

  writeFileSync(stackEnvPath, content, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(stackEnvPath, 0o600); } catch { /* best-effort */ }

  try {
    const logPath = migration0110LogPath(state);
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(
      logPath,
      `${new Date().toISOString()} migrate-voice-vars ${renamed.join("; ")}\n`,
      "utf-8",
    );
  } catch {
    /* best-effort */
  }

  return { migrated: true, reason: renamed.join("; ") };
}
