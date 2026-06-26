/**
 * Unit tests for versions.ts — Phase 5 pin-null semantics, channel preference,
 * and voice variant suffix utilities (constitution §4.2, §5).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  stripVoiceVariantSuffix,
  normalizePinValue,
  readPinnedVersions,
  readChannelPreference,
  writeChannelPreference,
  writeVersions,
  readVersions,
} from "./versions.js";
import type { ControlPlaneState } from "./types.js";

// ── stripVoiceVariantSuffix ──────────────────────────────────────────────────

describe("stripVoiceVariantSuffix", () => {
  it("strips -cpu suffix", () => {
    expect(stripVoiceVariantSuffix("0.12.0-cpu")).toBe("0.12.0");
  });
  it("strips -cu121 suffix", () => {
    expect(stripVoiceVariantSuffix("0.12.0-cu121")).toBe("0.12.0");
  });
  it("strips -rocm6 suffix", () => {
    expect(stripVoiceVariantSuffix("0.12.0-rocm6")).toBe("0.12.0");
  });
  it("is a no-op when no known suffix", () => {
    expect(stripVoiceVariantSuffix("0.12.0")).toBe("0.12.0");
    expect(stripVoiceVariantSuffix("latest")).toBe("latest");
    expect(stripVoiceVariantSuffix("0.12.0-rc.1")).toBe("0.12.0-rc.1");
  });
  it("also strips from a full image tag", () => {
    expect(stripVoiceVariantSuffix("openpalm/voice:0.12.0-cpu")).toBe("openpalm/voice:0.12.0");
  });
  it("strips moving-tag variant (latest-cpu)", () => {
    expect(stripVoiceVariantSuffix("latest-cpu")).toBe("latest");
  });
});

// ── normalizePinValue ────────────────────────────────────────────────────────

describe("normalizePinValue", () => {
  it("strips a legacy leading v", () => {
    expect(normalizePinValue("v0.12.0")).toBe("0.12.0");
    expect(normalizePinValue("v0.11.0")).toBe("0.11.0");
  });
  it("is a no-op for already-bare versions", () => {
    expect(normalizePinValue("0.12.0")).toBe("0.12.0");
    expect(normalizePinValue("latest")).toBe("latest");
  });
  it("trims whitespace", () => {
    expect(normalizePinValue("  0.12.0  ")).toBe("0.12.0");
  });
});

// ── Harness ──────────────────────────────────────────────────────────────────

function makeState(): { state: ControlPlaneState; cleanup: () => void } {
  const homeDir = mkdtempSync(join(tmpdir(), "op-versions-test-"));
  mkdirSync(join(homeDir, "state"), { recursive: true });
  mkdirSync(join(homeDir, "knowledge", "env"), { recursive: true });
  const state: ControlPlaneState = {
    homeDir,
    stackDir: join(homeDir, "system", "stack"),
    stashDir: join(homeDir, "knowledge"),
    configDir: join(homeDir, "config"),
    dataDir: join(homeDir, "data"),
    workspaceDir: join(homeDir, "workspace"),
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
  };
  return {
    state,
    cleanup: () => rmSync(homeDir, { recursive: true, force: true }),
  };
}

// ── readPinnedVersions ───────────────────────────────────────────────────────

describe("readPinnedVersions", () => {
  let home: ReturnType<typeof makeState>;
  beforeEach(() => { home = makeState(); });
  afterEach(() => { home.cleanup(); });

  it("returns null for every key when no state file exists (track latest)", () => {
    const pinned = readPinnedVersions(home.state);
    for (const v of Object.values(pinned)) expect(v).toBeNull();
  });

  it("returns null when the value is the moving tag 'latest'", () => {
    writeFileSync(
      join(home.state.homeDir, "state", "stack.state.env"),
      "OP_ASSISTANT_VERSION=latest\n"
    );
    const pinned = readPinnedVersions(home.state);
    expect(pinned.OP_ASSISTANT_VERSION).toBeNull();
  });

  it("returns null when the value is the moving tag 'next'", () => {
    writeFileSync(
      join(home.state.homeDir, "state", "stack.state.env"),
      "OP_ASSISTANT_VERSION=next\n"
    );
    const pinned = readPinnedVersions(home.state);
    expect(pinned.OP_ASSISTANT_VERSION).toBeNull();
  });

  it("returns the normalized version when explicitly pinned", () => {
    writeFileSync(
      join(home.state.homeDir, "state", "stack.state.env"),
      "OP_ASSISTANT_VERSION=0.12.0\n"
    );
    const pinned = readPinnedVersions(home.state);
    expect(pinned.OP_ASSISTANT_VERSION).toBe("0.12.0");
  });

  it("strips legacy v-prefix from a pinned value", () => {
    writeFileSync(
      join(home.state.homeDir, "state", "stack.state.env"),
      "OP_ASSISTANT_VERSION=v0.11.0\n"
    );
    const pinned = readPinnedVersions(home.state);
    expect(pinned.OP_ASSISTANT_VERSION).toBe("0.11.0");
  });

  it("strips voice variant suffix from OP_VOICE_VERSION on read (tolerant read §4.2)", () => {
    writeFileSync(
      join(home.state.homeDir, "state", "stack.state.env"),
      "OP_VOICE_VERSION=0.12.0-cpu\n"
    );
    const pinned = readPinnedVersions(home.state);
    // Legacy value with variant suffix — normalized to plain version
    expect(pinned.OP_VOICE_VERSION).toBe("0.12.0");
  });

  it("a legacy stack.env value is NOT a pin — it is the applied/current version, so pinned is null (the freeze-bug fix)", () => {
    // The old updater auto-wrote OP_*_VERSION into the legacy stack.env as the
    // CURRENT version. Reading it as a pin froze every existing install: the UI
    // showed it pinned and "update" re-applied that version forever. A deliberate
    // pin lives ONLY in state/; a legacy-only value means "tracking" (pinned null),
    // and update is free to advance it to the channel-latest.
    writeFileSync(
      join(home.state.homeDir, "knowledge", "env", "stack.env"),
      "OP_GUARDIAN_VERSION=0.12.33\n"
    );
    const pinned = readPinnedVersions(home.state);
    expect(pinned.OP_GUARDIAN_VERSION).toBe(null);
  });

  it("state file wins over legacy when both present", () => {
    writeFileSync(
      join(home.state.homeDir, "knowledge", "env", "stack.env"),
      "OP_ASSISTANT_VERSION=0.11.0\n"
    );
    writeFileSync(
      join(home.state.homeDir, "state", "stack.state.env"),
      "OP_ASSISTANT_VERSION=0.12.0\n"
    );
    const pinned = readPinnedVersions(home.state);
    expect(pinned.OP_ASSISTANT_VERSION).toBe("0.12.0");
  });

  it("acceptance: pin v0.11.0 → readPinnedVersions returns 0.11.0 (strips v)", () => {
    // Phase 5 acceptance criterion: pin v0.11.0 is normalized to 0.11.0
    writeVersions(home.state, { OP_ASSISTANT_VERSION: "v0.11.0" });
    const pinned = readPinnedVersions(home.state);
    expect(pinned.OP_ASSISTANT_VERSION).toBe("0.11.0");
  });
});

// ── readChannelPreference / writeChannelPreference ───────────────────────────

describe("readChannelPreference", () => {
  let home: ReturnType<typeof makeState>;
  beforeEach(() => { home = makeState(); });
  afterEach(() => { home.cleanup(); });

  it("defaults to 'latest' when no state file", () => {
    expect(readChannelPreference(home.state)).toBe("latest");
  });

  it("reads 'next' from state file", () => {
    writeFileSync(
      join(home.state.homeDir, "state", "stack.state.env"),
      "OP_UI_CHANNEL=next\n"
    );
    expect(readChannelPreference(home.state)).toBe("next");
  });

  it("reads 'latest' from state file", () => {
    writeFileSync(
      join(home.state.homeDir, "state", "stack.state.env"),
      "OP_UI_CHANNEL=latest\n"
    );
    expect(readChannelPreference(home.state)).toBe("latest");
  });

  it("falls back to 'latest' for unrecognized values", () => {
    writeFileSync(
      join(home.state.homeDir, "state", "stack.state.env"),
      "OP_UI_CHANNEL=bogus\n"
    );
    expect(readChannelPreference(home.state)).toBe("latest");
  });

  it("falls back to legacy stack.env (dual-read §1a)", () => {
    writeFileSync(
      join(home.state.homeDir, "knowledge", "env", "stack.env"),
      "OP_UI_CHANNEL=next\n"
    );
    expect(readChannelPreference(home.state)).toBe("next");
  });

  it("state file wins over legacy", () => {
    writeFileSync(
      join(home.state.homeDir, "knowledge", "env", "stack.env"),
      "OP_UI_CHANNEL=next\n"
    );
    writeFileSync(
      join(home.state.homeDir, "state", "stack.state.env"),
      "OP_UI_CHANNEL=latest\n"
    );
    expect(readChannelPreference(home.state)).toBe("latest");
  });
});

describe("writeChannelPreference", () => {
  let home: ReturnType<typeof makeState>;
  beforeEach(() => { home = makeState(); });
  afterEach(() => { home.cleanup(); });

  it("writes to state file and is readable back", () => {
    writeChannelPreference(home.state, "next");
    expect(readChannelPreference(home.state)).toBe("next");
    writeChannelPreference(home.state, "latest");
    expect(readChannelPreference(home.state)).toBe("latest");
  });

  it("throws on invalid channel", () => {
    expect(() => writeChannelPreference(home.state, "alpha")).toThrow(/Invalid channel/);
    expect(() => writeChannelPreference(home.state, "")).toThrow(/Invalid channel/);
  });

  it("write is atomic — does not corrupt existing keys in state file", () => {
    writeVersions(home.state, { OP_ASSISTANT_VERSION: "0.12.0" });
    writeChannelPreference(home.state, "next");
    // Both should be present
    expect(readChannelPreference(home.state)).toBe("next");
    expect(readVersions(home.state).OP_ASSISTANT_VERSION).toBe("0.12.0");
  });
});
