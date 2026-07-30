/**
 * OP_VOICE_LAN_ACCESS — the opt-in that grants the voice addon `assistant_net`
 * so the container-served UI can proxy `/voice` for LAN clients.
 *
 * Covers the reader (isVoiceLanAccessEnabled, voice-host-probes.ts) and the
 * overlay-inclusion gate (discoverStackOverlays, config-persistence.ts).
 * Compose-topology assertions for voice.compose.lan.yml itself live in
 * addon-network-boundary.test.ts, alongside the default (setting-off)
 * assertions this feature must not weaken.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isVoiceLanAccessEnabled } from "./voice-host-probes.js";
import { discoverStackOverlays } from "./config-persistence.js";

let homeDir = "";

afterEach(() => {
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = "";
});

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "openpalm-voice-lan-"));
  mkdirSync(join(dir, "system", "stack"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "system", "stack", "core.compose.yml"), "services: {}\n");
  return dir;
}

function writeStackEnv(dir: string, content: string): void {
  writeFileSync(join(dir, "state", "stack.env"), content);
}

function writeLanOverlay(dir: string): void {
  writeFileSync(join(dir, "system", "stack", "voice.compose.lan.yml"), "services: {}\n");
}

describe("isVoiceLanAccessEnabled", () => {
  test("defaults OFF when unset", () => {
    homeDir = makeHome();
    expect(isVoiceLanAccessEnabled(homeDir)).toBe(false);
  });

  test("defaults OFF when there is no stack.env at all", () => {
    homeDir = mkdtempSync(join(tmpdir(), "openpalm-voice-lan-nostate-"));
    expect(isVoiceLanAccessEnabled(homeDir)).toBe(false);
  });

  test.each(["1", "true", "TRUE", "True", "yes", "YES", " true "])(
    "%p is truthy",
    (value) => {
      homeDir = makeHome();
      writeStackEnv(homeDir, `OP_VOICE_LAN_ACCESS=${value}\n`);
      expect(isVoiceLanAccessEnabled(homeDir)).toBe(true);
    },
  );

  test.each(["0", "false", "FALSE", "no", "on", "enabled", ""])(
    "%p is falsy",
    (value) => {
      homeDir = makeHome();
      writeStackEnv(homeDir, `OP_VOICE_LAN_ACCESS=${value}\n`);
      expect(isVoiceLanAccessEnabled(homeDir)).toBe(false);
    },
  );
});

describe("discoverStackOverlays — voice.compose.lan.yml inclusion", () => {
  test("absent when the setting is off, even if the file exists", () => {
    homeDir = makeHome();
    writeLanOverlay(homeDir);
    writeStackEnv(homeDir, "OP_VOICE_LAN_ACCESS=false\n");
    const files = discoverStackOverlays(homeDir);
    expect(files.some((f) => f.endsWith("voice.compose.lan.yml"))).toBe(false);
  });

  test("absent when the setting is on but the file has not been seeded yet", () => {
    // Mirrors the CDI/rootless overlays' own double-gate (bring-up.ts
    // voiceCdiOverlayPath/voiceRootlessOverlayPath): a home mid-upgrade with
    // an old skeleton (no system/ refresh yet) must not reference a file
    // that does not exist on disk.
    homeDir = makeHome();
    writeStackEnv(homeDir, "OP_VOICE_LAN_ACCESS=true\n");
    const files = discoverStackOverlays(homeDir);
    expect(files.some((f) => f.endsWith("voice.compose.lan.yml"))).toBe(false);
  });

  test("included when the setting is on AND the file exists", () => {
    homeDir = makeHome();
    writeLanOverlay(homeDir);
    writeStackEnv(homeDir, "OP_VOICE_LAN_ACCESS=true\n");
    const files = discoverStackOverlays(homeDir);
    expect(files.some((f) => f.endsWith("voice.compose.lan.yml"))).toBe(true);
  });

  test("ordered after the managed trio and before the user's custom overlay", () => {
    homeDir = makeHome();
    writeFileSync(join(homeDir, "system", "stack", "services.compose.yml"), "services: {}\n");
    writeFileSync(join(homeDir, "system", "stack", "portals.compose.yml"), "services: {}\n");
    writeLanOverlay(homeDir);
    writeStackEnv(homeDir, "OP_VOICE_LAN_ACCESS=true\n");
    mkdirSync(join(homeDir, "config", "stack"), { recursive: true });
    writeFileSync(join(homeDir, "config", "stack", "custom.compose.yml"), "services: {}\n");

    const files = discoverStackOverlays(homeDir);
    const names = files.map((f) => f.split("/").pop());
    expect(names).toEqual([
      "core.compose.yml",
      "services.compose.yml",
      "portals.compose.yml",
      "voice.compose.lan.yml",
      "custom.compose.yml",
    ]);
  });
});
