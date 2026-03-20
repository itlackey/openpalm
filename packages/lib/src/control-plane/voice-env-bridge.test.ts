import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVoiceEnvVars, applyVoiceEnvVars, isVoiceChannelInstalled } from "./voice-env-bridge.js";
import type { CapabilityAssignments, CanonicalConnectionProfile, ControlPlaneState } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────

const TEST_API_KEY_VAR = "TEST_VOICE_BRIDGE_API_KEY";
const TEST_API_KEY_VAR_2 = "TEST_VOICE_BRIDGE_API_KEY_2";

function makeProfile(overrides?: Partial<CanonicalConnectionProfile>): CanonicalConnectionProfile {
  return {
    id: "openai-main",
    name: "OpenAI",
    kind: "openai_compatible_remote",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    auth: { mode: "api_key", apiKeySecretRef: `env:${TEST_API_KEY_VAR}` },
    ...overrides,
  };
}

function makeAssignments(overrides?: Partial<CapabilityAssignments>): CapabilityAssignments {
  return {
    llm: { connectionId: "openai-main", model: "gpt-4o" },
    embeddings: { connectionId: "openai-main", model: "text-embedding-3-small" },
    ...overrides,
  };
}

// ── Tests: buildVoiceEnvVars ─────────────────────────────────────────────

describe("buildVoiceEnvVars", () => {
  let tmpDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "voice-env-test-"));
    vaultDir = tmpDir;
    writeFileSync(join(vaultDir, "user.env"), `${TEST_API_KEY_VAR}=sk-test-key-123\n`);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns TTS env vars when TTS has a connectionId", () => {
    const profiles = [makeProfile()];
    const assignments = makeAssignments({
      tts: { enabled: true, connectionId: "openai-main", model: "tts-1", voice: "alloy" },
    });

    const vars = buildVoiceEnvVars(assignments, profiles, vaultDir);

    expect(vars.TTS_BASE_URL).toBe("https://api.openai.com");
    expect(vars.TTS_API_KEY).toBe("sk-test-key-123");
    expect(vars.TTS_MODEL).toBe("tts-1");
    expect(vars.TTS_VOICE).toBe("alloy");
  });

  it("returns STT env vars when STT has a connectionId", () => {
    const profiles = [makeProfile()];
    const assignments = makeAssignments({
      stt: { enabled: true, connectionId: "openai-main", model: "whisper-1" },
    });

    const vars = buildVoiceEnvVars(assignments, profiles, vaultDir);

    expect(vars.STT_BASE_URL).toBe("https://api.openai.com");
    expect(vars.STT_API_KEY).toBe("sk-test-key-123");
    expect(vars.STT_MODEL).toBe("whisper-1");
  });

  it("clears env vars when TTS assignment is disabled", () => {
    const profiles = [makeProfile()];
    const assignments = makeAssignments({ tts: { enabled: false } });

    const vars = buildVoiceEnvVars(assignments, profiles, vaultDir);

    expect(vars.TTS_BASE_URL).toBe("");
    expect(vars.TTS_API_KEY).toBe("");
    expect(vars.TTS_MODEL).toBe("");
    expect(vars.TTS_VOICE).toBe("");
  });

  it("clears env vars when STT assignment is disabled", () => {
    const profiles = [makeProfile()];
    const assignments = makeAssignments({ stt: { enabled: false } });

    const vars = buildVoiceEnvVars(assignments, profiles, vaultDir);

    expect(vars.STT_BASE_URL).toBe("");
    expect(vars.STT_API_KEY).toBe("");
    expect(vars.STT_MODEL).toBe("");
  });

  it("clears env vars when TTS assignment is absent", () => {
    const profiles = [makeProfile()];
    const assignments = makeAssignments();

    const vars = buildVoiceEnvVars(assignments, profiles, vaultDir);

    expect(vars.TTS_BASE_URL).toBe("");
    expect(vars.TTS_API_KEY).toBe("");
    expect(vars.TTS_MODEL).toBe("");
    expect(vars.TTS_VOICE).toBe("");
  });

  it("sets no base URL or API key for local engine (no connectionId)", () => {
    const profiles = [makeProfile()];
    const assignments = makeAssignments({
      tts: { enabled: true, model: "kokoro" },
      stt: { enabled: true, model: "whisper-local" },
    });

    const vars = buildVoiceEnvVars(assignments, profiles, vaultDir);

    expect(vars.TTS_BASE_URL).toBe("");
    expect(vars.TTS_API_KEY).toBe("");
    expect(vars.TTS_MODEL).toBe("kokoro");
    expect(vars.STT_BASE_URL).toBe("");
    expect(vars.STT_API_KEY).toBe("");
    expect(vars.STT_MODEL).toBe("whisper-local");
  });

  it("strips trailing /v1 from base URL", () => {
    const profiles = [makeProfile({ baseUrl: "https://api.openai.com/v1" })];
    const assignments = makeAssignments({
      tts: { enabled: true, connectionId: "openai-main", model: "tts-1" },
    });

    const vars = buildVoiceEnvVars(assignments, profiles, vaultDir);

    expect(vars.TTS_BASE_URL).toBe("https://api.openai.com");
  });

  it("handles profile with auth mode 'none' (no API key)", () => {
    const profiles = [makeProfile({ auth: { mode: "none" } })];
    const assignments = makeAssignments({
      tts: { enabled: true, connectionId: "openai-main", model: "tts-1" },
    });

    const vars = buildVoiceEnvVars(assignments, profiles, vaultDir);

    expect(vars.TTS_API_KEY).toBe("");
  });

  it("clears env vars when connectionId references a missing profile", () => {
    const profiles: CanonicalConnectionProfile[] = [];
    const assignments = makeAssignments({
      tts: { enabled: true, connectionId: "missing-profile", model: "tts-1" },
    });

    const vars = buildVoiceEnvVars(assignments, profiles, vaultDir);

    expect(vars.TTS_BASE_URL).toBe("");
    expect(vars.TTS_API_KEY).toBe("");
    expect(vars.TTS_MODEL).toBe("");
    expect(vars.TTS_VOICE).toBe("");
  });

  it("handles both TTS and STT with different connections", () => {
    const groqProfile = makeProfile({
      id: "groq-main",
      name: "Groq",
      provider: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      auth: { mode: "api_key", apiKeySecretRef: `env:${TEST_API_KEY_VAR_2}` },
    });
    writeFileSync(join(vaultDir, "user.env"), `${TEST_API_KEY_VAR}=sk-openai\n${TEST_API_KEY_VAR_2}=gsk-groq\n`);

    const profiles = [makeProfile(), groqProfile];
    const assignments = makeAssignments({
      tts: { enabled: true, connectionId: "openai-main", model: "tts-1", voice: "alloy" },
      stt: { enabled: true, connectionId: "groq-main", model: "whisper-large-v3" },
    });

    const vars = buildVoiceEnvVars(assignments, profiles, vaultDir);

    expect(vars.TTS_BASE_URL).toBe("https://api.openai.com");
    expect(vars.TTS_API_KEY).toBe("sk-openai");
    expect(vars.TTS_MODEL).toBe("tts-1");
    expect(vars.TTS_VOICE).toBe("alloy");
    expect(vars.STT_BASE_URL).toBe("https://api.groq.com/openai");
    expect(vars.STT_API_KEY).toBe("gsk-groq");
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
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(join(vaultDir, "user.env"), "OPENAI_API_KEY=test\n");
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

  it("writes env vars to vault/user.env and returns true", () => {
    const state = makeState();
    const result = applyVoiceEnvVars(state, {
      TTS_BASE_URL: "https://api.openai.com",
      TTS_API_KEY: "sk-test",
    });

    expect(result).toBe(true);

    const content = readFileSync(join(vaultDir, "user.env"), "utf-8");
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

  it("returns true when legacy voice.yml exists", () => {
    mkdirSync(join(tmpDir, "config", "channels"), { recursive: true });
    writeFileSync(join(tmpDir, "config", "channels", "voice.yml"), "services: {}\n");
    expect(isVoiceChannelInstalled(tmpDir)).toBe(true);
  });

  it("returns true when voice component instance is enabled", () => {
    mkdirSync(join(tmpDir, "data", "components"), { recursive: true });
    writeFileSync(
      join(tmpDir, "data", "components", "enabled.json"),
      JSON.stringify([{ id: "my-voice", component: "voice", enabled: true }]),
    );
    expect(isVoiceChannelInstalled(tmpDir)).toBe(true);
  });

  it("returns false when no voice channel or component exists", () => {
    expect(isVoiceChannelInstalled(tmpDir)).toBe(false);
  });

  it("returns false when voice component is disabled", () => {
    mkdirSync(join(tmpDir, "data", "components"), { recursive: true });
    writeFileSync(
      join(tmpDir, "data", "components", "enabled.json"),
      JSON.stringify([{ id: "my-voice", component: "voice", enabled: false }]),
    );
    expect(isVoiceChannelInstalled(tmpDir)).toBe(false);
  });
});
