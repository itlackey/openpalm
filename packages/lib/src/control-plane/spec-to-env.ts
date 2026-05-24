/**
 * Config-to-env derivation pipeline.
 *
 * Produces system env vars for stack.env (non-secret infrastructure config).
 * Voice channel vars (TTS/STT) are written separately via writeVoiceVars.
 */

import type { StackSpec } from "./stack-spec.js";
import { SPEC_DEFAULTS } from "./stack-spec.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mergeEnvContent } from "./env.js";

/**
 * Derive the system.env key-value pairs from the StackSpec.
 * Secrets (tokens, API keys, HMAC) are NOT included — the caller merges them.
 */
export function deriveSystemEnvFromSpec(
  spec: StackSpec,
  homeDir: string,
): Record<string, string> {
  const uid = typeof process.getuid === "function" ? (process.getuid() ?? 1000) : 1000;
  const gid = typeof process.getgid === "function" ? (process.getgid() ?? 1000) : 1000;

  const ports = SPEC_DEFAULTS.ports;
  const image = SPEC_DEFAULTS.image;

  const result: Record<string, string> = {};

  // Paths
  result["OP_HOME"] = homeDir;
  result["OP_UID"] = String(uid);
  result["OP_GID"] = String(gid);
  // Image
  result["OP_IMAGE_NAMESPACE"] = image.namespace;
  result["OP_IMAGE_TAG"] = image.tag;

  // Ports
  result["OP_ASSISTANT_PORT"] = String(ports.assistant);
  result["OP_ADMIN_PORT"] = String(ports.admin);
  result["OP_ADMIN_OPENCODE_PORT"] = String(ports.adminOpencode);
  result["OP_GUARDIAN_PORT"] = String(ports.guardian);
  result["OP_ASSISTANT_SSH_PORT"] = String(ports.assistantSsh);

  void spec; // spec reserved for future use; ports/image come from SPEC_DEFAULTS

  return result;
}

// ── Voice Channel Env Vars ────────────────────────────────────────────────

export type VoiceVarsConfig = {
  tts?: {
    enabled?: boolean;
    /** Engine name (e.g. "kokoro", "elevenlabs", "browser"). */
    engine?: string;
    /** Optional sub-provider qualifier when an engine fronts multiple providers. */
    provider?: string;
    baseURL?: string;
    model?: string;
    voice?: string;
  };
  stt?: {
    enabled?: boolean;
    engine?: string;
    provider?: string;
    baseURL?: string;
    model?: string;
    language?: string;
  };
};

/**
 * Write TTS/STT env vars to stack.env for the voice channel container.
 * `engine` always writes (even if it's the only field) so picking an
 * engine without filling in URL/model still persists.
 */
export function writeVoiceVars(config: VoiceVarsConfig, stackDir: string): void {
  const stackEnvPath = `${stackDir}/stack.env`;
  const base = existsSync(stackEnvPath) ? readFileSync(stackEnvPath, "utf-8") : "";
  const vars: Record<string, string> = {};

  // OP_ prefix is mandatory: unprefixed TTS_*/STT_* names collide with
  // other tooling (OpenAI clients, kokoro-fastapi, etc.) commonly set in
  // operator shells. The UI server only reads OP_-prefixed vars from
  // process.env, so a leaked host TTS_VOICE can't silently override the
  // saved selection.
  const { tts, stt } = config;
  if (tts?.enabled !== false) {
    if (tts?.engine) vars["OP_TTS_ENGINE"] = tts.engine;
    if (tts?.provider) vars["OP_TTS_PROVIDER"] = tts.provider;
    if (tts?.baseURL) vars["OP_TTS_BASE_URL"] = tts.baseURL;
    if (tts?.model) vars["OP_TTS_MODEL"] = tts.model;
    if (tts?.voice) vars["OP_TTS_VOICE"] = tts.voice;
  }
  if (stt?.enabled !== false) {
    if (stt?.engine) vars["OP_STT_ENGINE"] = stt.engine;
    if (stt?.provider) vars["OP_STT_PROVIDER"] = stt.provider;
    if (stt?.baseURL) vars["OP_STT_BASE_URL"] = stt.baseURL;
    if (stt?.model) vars["OP_STT_MODEL"] = stt.model;
    if (stt?.language) vars["OP_STT_LANGUAGE"] = stt.language;
  }

  if (Object.keys(vars).length === 0) return;

  let content = mergeEnvContent(base, vars, {
    sectionHeader: "# ── Voice Channel (TTS/STT) ──────────────────────────────────────────",
  });
  if (!content.endsWith("\n")) content += "\n";
  writeFileSync(stackEnvPath, content, { mode: 0o600 });
}
