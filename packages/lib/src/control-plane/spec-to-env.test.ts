import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveSystemEnvFromSpec, writeVoiceVars } from "./spec-to-env.js";

const MINIMAL_SPEC = { version: 2 as const };

let tempDir = "";

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "openpalm-spec-env-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("deriveSystemEnvFromSpec", () => {
  test("produces OP_HOME", () => {
    const result = deriveSystemEnvFromSpec(MINIMAL_SPEC, "/home/op");
    expect(result.OP_HOME).toBe("/home/op");
  });

  test("produces default port values", () => {
    const result = deriveSystemEnvFromSpec(MINIMAL_SPEC, "/home/op");
    expect(result.OP_ASSISTANT_PORT).toBe("3800");
    expect(result.OP_GUARDIAN_PORT).toBe("3899");
  });

  test("does not include the retired memory service port", () => {
    const result = deriveSystemEnvFromSpec(MINIMAL_SPEC, "/home/op");
    const retired = "OP_" + "MEMORY_PORT";
    expect(result[retired]).toBeUndefined();
  });

  test("does not include LLM provider in system env", () => {
    const result = deriveSystemEnvFromSpec(MINIMAL_SPEC, "/home/op");
    expect(result.SYSTEM_LLM_PROVIDER).toBeUndefined();
    expect(result.SYSTEM_LLM_MODEL).toBeUndefined();
  });

  test("does not include removed feature flags", () => {
    const result = deriveSystemEnvFromSpec(MINIMAL_SPEC, "/home/op");
    expect(result.OP_OLLAMA_ENABLED).toBeUndefined();
    expect(result.OP_ADMIN_ENABLED).toBeUndefined();
  });
});

describe("writeVoiceVars", () => {
  test("writes TTS vars to stack.env", () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "stack.env"), "# stack env\n");

    writeVoiceVars({
      tts: { baseURL: "https://tts.example.com/v1", model: "tts-1", voice: "alloy" },
    }, tempDir);

    const content = readFileSync(join(tempDir, "stack.env"), "utf-8");
    expect(content).toContain("OP_TTS_BASE_URL=https://tts.example.com/v1");
    expect(content).toContain("OP_TTS_MODEL=tts-1");
    expect(content).toContain("OP_TTS_VOICE=alloy");
  });

  test("writes STT vars to stack.env", () => {
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(join(tempDir, "stack.env"), "# stack env\n");

    writeVoiceVars({
      stt: { baseURL: "https://stt.example.com/v1", model: "whisper-1", language: "en" },
    }, tempDir);

    const content = readFileSync(join(tempDir, "stack.env"), "utf-8");
    expect(content).toContain("OP_STT_BASE_URL=https://stt.example.com/v1");
    expect(content).toContain("OP_STT_MODEL=whisper-1");
    expect(content).toContain("OP_STT_LANGUAGE=en");
  });

  test("creates stack.env if it does not exist", () => {
    mkdirSync(tempDir, { recursive: true });

    writeVoiceVars({
      tts: { baseURL: "https://tts.example.com/v1", model: "tts-1" },
    }, tempDir);

    const content = readFileSync(join(tempDir, "stack.env"), "utf-8");
    expect(content).toContain("OP_TTS_BASE_URL=https://tts.example.com/v1");
  });

  test("is a no-op when no vars are provided", () => {
    mkdirSync(tempDir, { recursive: true });
    const stackEnvPath = join(tempDir, "stack.env");
    writeFileSync(stackEnvPath, "EXISTING=value\n");

    writeVoiceVars({}, tempDir);

    // File should be unchanged
    const content = readFileSync(stackEnvPath, "utf-8");
    expect(content).toBe("EXISTING=value\n");
  });
});
