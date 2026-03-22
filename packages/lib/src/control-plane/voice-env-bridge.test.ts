import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVoiceEnvVars, applyVoiceEnvVars, isVoiceChannelInstalled } from "./voice-env-bridge.js";
import type { ControlPlaneState } from "./types.js";
import type { StackSpecTts, StackSpecStt } from "./stack-spec.js";

// ── Tests: buildVoiceEnvVars ─────────────────────────────────────────────

describe("buildVoiceEnvVars", () => {
  it("returns TTS env vars when TTS is enabled with model and voice", () => {
    const tts: StackSpecTts = { enabled: true, provider: "openai", model: "tts-1", voice: "alloy" };

    const vars = buildVoiceEnvVars(tts);

    expect(vars.TTS_BASE_URL).toBe("");
    expect(vars.TTS_API_KEY).toBe("");
    expect(vars.TTS_MODEL).toBe("tts-1");
    expect(vars.TTS_VOICE).toBe("alloy");
  });

  it("returns STT env vars when STT is enabled with model", () => {
    const stt: StackSpecStt = { enabled: true, provider: "openai", model: "whisper-1" };

    const vars = buildVoiceEnvVars(undefined, stt);

    expect(vars.STT_BASE_URL).toBe("");
    expect(vars.STT_API_KEY).toBe("");
    expect(vars.STT_MODEL).toBe("whisper-1");
  });

  it("clears env vars when TTS is disabled", () => {
    const tts: StackSpecTts = { enabled: false };

    const vars = buildVoiceEnvVars(tts);

    expect(vars.TTS_BASE_URL).toBe("");
    expect(vars.TTS_API_KEY).toBe("");
    expect(vars.TTS_MODEL).toBe("");
    expect(vars.TTS_VOICE).toBe("");
  });

  it("clears env vars when STT is disabled", () => {
    const stt: StackSpecStt = { enabled: false };

    const vars = buildVoiceEnvVars(undefined, stt);

    expect(vars.STT_BASE_URL).toBe("");
    expect(vars.STT_API_KEY).toBe("");
    expect(vars.STT_MODEL).toBe("");
  });

  it("clears env vars when TTS is absent", () => {
    const vars = buildVoiceEnvVars(undefined);

    expect(vars.TTS_BASE_URL).toBe("");
    expect(vars.TTS_API_KEY).toBe("");
    expect(vars.TTS_MODEL).toBe("");
    expect(vars.TTS_VOICE).toBe("");
  });

  it("sets model but no base URL or API key for local engine", () => {
    const tts: StackSpecTts = { enabled: true, model: "kokoro" };
    const stt: StackSpecStt = { enabled: true, model: "whisper-local" };

    const vars = buildVoiceEnvVars(tts, stt);

    expect(vars.TTS_BASE_URL).toBe("");
    expect(vars.TTS_API_KEY).toBe("");
    expect(vars.TTS_MODEL).toBe("kokoro");
    expect(vars.STT_BASE_URL).toBe("");
    expect(vars.STT_API_KEY).toBe("");
    expect(vars.STT_MODEL).toBe("whisper-local");
  });

  it("handles both TTS and STT enabled simultaneously", () => {
    const tts: StackSpecTts = { enabled: true, provider: "openai", model: "tts-1", voice: "alloy" };
    const stt: StackSpecStt = { enabled: true, provider: "groq", model: "whisper-large-v3" };

    const vars = buildVoiceEnvVars(tts, stt);

    expect(vars.TTS_BASE_URL).toBe("");
    expect(vars.TTS_API_KEY).toBe("");
    expect(vars.TTS_MODEL).toBe("tts-1");
    expect(vars.TTS_VOICE).toBe("alloy");
    expect(vars.STT_BASE_URL).toBe("");
    expect(vars.STT_API_KEY).toBe("");
    expect(vars.STT_MODEL).toBe("whisper-large-v3");
  });
});

// ── Tests: applyVoiceEnvVars ──────────────────────────────────────────────

describe("applyVoiceEnvVars", () => {
  let tmpDir: string;
  let homeDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "voice-apply-test-"));
    homeDir = tmpDir;
    vaultDir = join(tmpDir, "vault");
    mkdirSync(join(vaultDir, "user"), { recursive: true });
    writeFileSync(join(vaultDir, "user", "user.env"), "OPENAI_API_KEY=test\n");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeState(): ControlPlaneState {
    return {
      adminToken: "test",
      assistantToken: "test",
      setupToken: "test",
      homeDir,
      configDir: join(tmpDir, "config"),
      vaultDir,
      dataDir: join(tmpDir, "data"),
      logsDir: join(tmpDir, "logs"),
      cacheDir: join(tmpDir, "cache"),
      services: {},
    };
  }

  it("writes env vars to vault/user/user.env and returns true", () => {
    const state = makeState();
    const result = applyVoiceEnvVars(state, {
      TTS_BASE_URL: "https://api.openai.com",
      TTS_API_KEY: "sk-test",
    });

    expect(result).toBe(true);

    const content = readFileSync(join(vaultDir, "user", "user.env"), "utf-8");
    expect(content).toContain("TTS_BASE_URL=https://api.openai.com");
    expect(content).toContain("TTS_API_KEY=sk-test");
    expect(content).toContain("OPENAI_API_KEY=test"); // preserved
  });

  it("returns false for empty env vars", () => {
    const state = makeState();
    const result = applyVoiceEnvVars(state, {});
    expect(result).toBe(false);
  });
});

// ── Tests: isVoiceChannelInstalled ────────────────────────────────────────

describe("isVoiceChannelInstalled", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "voice-detect-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when voice addon compose exists", () => {
    mkdirSync(join(tmpDir, "stack", "addons", "voice"), { recursive: true });
    writeFileSync(join(tmpDir, "stack", "addons", "voice", "compose.yml"), "services:\n  voice:\n    image: test\n");
    expect(isVoiceChannelInstalled(tmpDir)).toBe(true);
  });

  it("returns false when voice addon does not exist", () => {
    expect(isVoiceChannelInstalled(tmpDir)).toBe(false);
  });

  it("returns false when stack/addons exists but no voice subdirectory", () => {
    mkdirSync(join(tmpDir, "stack", "addons", "chat"), { recursive: true });
    writeFileSync(join(tmpDir, "stack", "addons", "chat", "compose.yml"), "services:\n  chat:\n    image: test\n");
    expect(isVoiceChannelInstalled(tmpDir)).toBe(false);
  });
});
