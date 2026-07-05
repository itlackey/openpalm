import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for docs/reviews/fable-security-remediation-plan.md §S.7:
// the security-posture prose in AGENTS.md / docs/technical/core-principles.md
// had drifted from what the code (as of S.1a/S.2.1/S.4/S.6a/S.8 — see that
// file's Implementation Status table) actually does. This test fails while
// any of the drift is present and stays green once the docs are truthful.
//
// Scope is deliberately narrow to what S.7 owns (security posture): it does
// NOT assert the non-security four-tree/layout rewrite that is Part A 1.3's
// job, so it can land independently without fighting that item's diff.

const ROOT = join(import.meta.dir, "..");
const corePrinciples = readFileSync(join(ROOT, "docs/technical/core-principles.md"), "utf-8");
const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf-8");
const proxy = readFileSync(join(ROOT, "packages/guardian/src/proxy.ts"), "utf-8");
const ocBounds = readFileSync(join(ROOT, "packages/guardian/src/oc-bounds.ts"), "utf-8");

describe("S.7 — fictional pipeline description purged", () => {
  it("AGENTS.md does not describe the guardian as HMAC-signed", () => {
    expect(agents).not.toMatch(/HMAC-signed/);
  });

  it("AGENTS.md attributes the guardian request pipeline to packages/guardian/src/", () => {
    expect(agents).toMatch(/packages\/guardian\/src\/server\.ts/);
  });

  it("proxy.ts and oc-bounds.ts no longer narrate a deleted nonce/replay-store mechanism", () => {
    expect(proxy).not.toMatch(/nonce/i);
    expect(ocBounds).not.toMatch(/nonce/i);
    expect(ocBounds).not.toMatch(/replay\.ts/);
  });
});

describe("S.7 — service port table matches portals.compose.yml", () => {
  it("documents the guardian direct (3830) and admin (3831) listeners", () => {
    expect(corePrinciples).toMatch(/3830/);
    expect(corePrinciples).toMatch(/3831/);
  });

  it("documents chat (3820) and api (3821) as the SAME internal 8182 listener, not separate 8181/8182 services", () => {
    expect(corePrinciples).toMatch(/3820/);
    expect(corePrinciples).toMatch(/3821/);
    expect(corePrinciples).toMatch(/8182/);
    expect(corePrinciples).not.toMatch(/8181/);
  });

  it("documents the voice addon's real internal port (8880), not the stale 8186", () => {
    expect(corePrinciples).not.toMatch(/8186/);
    expect(corePrinciples).toMatch(/8880/);
  });
});

describe("S.7 — OP_ALLOW_REMOTE_SETUP documented as an explicit opt-in, not an absolute", () => {
  it("does not assert admin is unreachable 'under any configuration'", () => {
    expect(corePrinciples).not.toMatch(/under any configuration/);
  });

  it("names OP_ALLOW_REMOTE_SETUP as the sanctioned opt-in that changes the admin bind", () => {
    expect(corePrinciples).toMatch(/OP_ALLOW_REMOTE_SETUP/);
  });
});

describe("S.7 — assistant-isolation mount list (invariant 3) matches core.compose.yml", () => {
  it("attributes the assistant's /etc/opencode mount to system/assistant/, not config/assistant/", () => {
    expect(corePrinciples).not.toMatch(/`config\/assistant\/ -> \/etc\/opencode`/);
    expect(corePrinciples).toMatch(/system\/assistant\/? -> \/etc\/opencode/);
  });

  it("includes the /host-stash mount", () => {
    expect(corePrinciples).toMatch(/\/host-stash/);
  });
});

describe("S.7 — content-validation posture matches the shipped compose default (S.3 not yet landed)", () => {
  it("core-principles.md does not claim the stage is 'off by default' as an absolute", () => {
    expect(corePrinciples).not.toMatch(/opt-in and off by default/);
  });

  it("AGENTS.md does not claim the guardian's content validation is off by default", () => {
    expect(agents).not.toMatch(/off by default/);
  });
});

describe("S.7 — guardian documented as a profile-gated ingress addon, not an always-on core container", () => {
  it("core-principles.md does not claim there are unconditionally 'two core containers'", () => {
    expect(corePrinciples).not.toMatch(/There are two core containers/);
  });

  it("AGENTS.md does not claim 'Two core containers' including the guardian", () => {
    expect(agents).not.toMatch(/Two core containers/);
  });
});

describe("S.7 — assistant/Admin-API relationship (D12) not misdrawn", () => {
  it("AGENTS.md's architecture diagram does not show the assistant calling the Admin API", () => {
    expect(agents).not.toMatch(/Assistant\s*-+>\s*Admin API/);
  });

  it("AGENTS.md does not claim the assistant calls authenticated admin APIs on user request", () => {
    expect(agents).not.toMatch(/assistant calls through authenticated admin APIs/);
  });
});

describe("S.7 — dead ADMIN_TOKEN reference deleted (D18, narrow slice)", () => {
  it("AGENTS.md no longer references the nonexistent ADMIN_TOKEN env var", () => {
    expect(agents).not.toMatch(/\bADMIN_TOKEN\b/);
  });
});

describe("S.7 — guardian admin listener documented (D21, narrow slice)", () => {
  it("core-principles.md documents the guardian admin listener (3831 / GUARDIAN_ADMIN_TOKEN_FILE)", () => {
    expect(corePrinciples).toMatch(/GUARDIAN_ADMIN_TOKEN_FILE/);
  });
});

describe("S.7 — no fictional assistant token (D22)", () => {
  it("core-principles.md does not claim an 'assistant token' the admin UI edits", () => {
    expect(corePrinciples).not.toMatch(/Admin and assistant tokens/);
  });
});

describe("S.7 — x-openpalm-user trust model documented plainly (rev3-F4)", () => {
  it("core-principles.md states the header is trusted from an authenticated principal", () => {
    expect(corePrinciples).toMatch(/x-openpalm-user/);
  });
});
