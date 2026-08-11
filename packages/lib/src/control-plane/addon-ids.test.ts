/**
 * Single-source-of-truth contract for the portal/guardian addon id sets.
 *
 * Two DISTINCT sets, historically duplicated (and drifting) across
 * lifecycle.ts, addons.ts and config-persistence.ts:
 *   • GUARDIAN_INGRESS_ADDON_IDS — addons whose ingress is served by the
 *     guardian; gates whether guardian is deployed. Mirrors the guardian
 *     `profiles:` gate in portals.compose.yml (INCLUDES `gateway`).
 *   • PORTAL_SECRET_ADDON_IDS — portals that own a `portal_<id>_secret`; gates
 *     ensurePortalSecret. Mirrors the guardian `portal_*_secret` mounts
 *     (EXCLUDES `gateway`, which has no secret of its own).
 *
 * These tests pin membership + intent so the two sets cannot silently re-merge
 * or drift from the compose stack again.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_ADDON_IDS,
  EXPERIMENTAL_ADDON_IDS,
  GUARDIAN_INGRESS_ADDON_IDS,
  hasGuardianIngressAddon,
  isExperimentalAddon,
  PORTAL_SECRET_ADDON_IDS,
} from "./addon-ids.js";

const COMPOSE_PATH = fileURLToPath(
  new URL("../../../skeleton/system/stack/portals.compose.yml", import.meta.url),
);

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

describe("guardian ingress addon ids", () => {
  it("every member is a built-in addon", () => {
    for (const id of GUARDIAN_INGRESS_ADDON_IDS) {
      expect(BUILTIN_ADDON_IDS).toContain(id);
    }
  });

  it("includes gateway (guardian-served, no portal container of its own)", () => {
    expect(GUARDIAN_INGRESS_ADDON_IDS).toContain("gateway");
  });

  it("keeps Paperclip as a normal non-ingress addon", () => {
    expect(BUILTIN_ADDON_IDS).toContain("paperclip");
    expect(GUARDIAN_INGRESS_ADDON_IDS).not.toContain("paperclip");
  });

  it("requires guardian for every ingress addon and no unrelated addon", () => {
    for (const id of GUARDIAN_INGRESS_ADDON_IDS) {
      expect(hasGuardianIngressAddon([id])).toBe(true);
    }
    expect(hasGuardianIngressAddon([])).toBe(false);
    expect(hasGuardianIngressAddon(["ollama", "voice"])).toBe(false);
  });

  it("mirrors the guardian service profile gate in portals.compose.yml", () => {
    const compose = readFileSync(COMPOSE_PATH, "utf8");
    const profileLine = compose
      .split("\n")
      .find((l) => l.includes("profiles:") && l.includes("addon.gateway"));
    expect(profileLine).toBeDefined();
    const profileIds = [...(profileLine ?? "").matchAll(/addon\.([a-z]+)/g)].map((m) => m[1]);
    expect(sorted(profileIds)).toEqual(sorted(GUARDIAN_INGRESS_ADDON_IDS));
  });
});

describe("portal secret addon ids", () => {
  it("is a strict subset of the guardian ingress set (no gateway)", () => {
    for (const id of PORTAL_SECRET_ADDON_IDS) {
      expect(GUARDIAN_INGRESS_ADDON_IDS).toContain(id);
    }
    expect(PORTAL_SECRET_ADDON_IDS).not.toContain("gateway");
  });

  it("mirrors the portal_*_secret set the guardian mounts in portals.compose.yml", () => {
    const compose = readFileSync(COMPOSE_PATH, "utf8");
    const secretIds = [...compose.matchAll(/portal_([a-z]+)_secret/g)].map((m) => m[1]);
    const unique = [...new Set(secretIds)];
    expect(sorted(unique)).toEqual(sorted(PORTAL_SECRET_ADDON_IDS));
  });
});

describe("experimental addon ids", () => {
  it("every member is a built-in addon", () => {
    // A stale or misspelled id here would silently mark nothing, and the
    // operator would never see the warning the list exists to give.
    for (const id of EXPERIMENTAL_ADDON_IDS) {
      expect(BUILTIN_ADDON_IDS).toContain(id);
    }
  });

  it("marks the two addons that depend on third parties OpenPalm cannot verify", () => {
    expect(sorted(EXPERIMENTAL_ADDON_IDS)).toEqual(["paperclip", "remote"]);
  });

  it("leaves first-party addons unmarked", () => {
    for (const id of ["voice", "chat", "api", "discord", "slack", "gateway", "ollama"]) {
      expect(isExperimentalAddon(id)).toBe(false);
    }
  });

  it("is advisory only — it does not remove an addon from the available set", () => {
    // Experimental must never mean hidden or gated: enabling one is a normal
    // enable, and the flag only changes what the operator is told.
    for (const id of EXPERIMENTAL_ADDON_IDS) {
      expect(isExperimentalAddon(id)).toBe(true);
      expect(BUILTIN_ADDON_IDS).toContain(id);
    }
  });
});
