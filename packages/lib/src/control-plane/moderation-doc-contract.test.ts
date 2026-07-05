/**
 * Guardian moderation.md doc-contract guardrail (Fable remediation 1.2).
 *
 * Decision (docs/reviews/fable-remediation-plan.md §1.2): `moderation.md` stays
 * in the MANAGED `system/guardian/` tree (bind-mounted at the guardian's
 * `OPENCODE_CONFIG_DIR=/etc/opencode`) and is documented as managed / not
 * user-editable — NOT relocated to `config/guardian/` (that tree mounts at
 * `~/.config/opencode`, a different path OpenCode does not read instructions
 * from). `core-assets.ts`'s `overwriteSystemTree` has no skip-if-user-modified
 * exception (verified in core-assets.test.ts: "overwrites a changed file and
 * backs up the old copy") — `SHIPPED_DEFAULT_HASHES` was deleted from the
 * codebase, so core-principles.md must not describe it as live.
 *
 * These assertions pin BOTH sides of the contract so a future edit can't
 * silently drift the doc from the code again:
 *   - the phantom skip-if-user-modified mechanism must not be described as live
 *   - the doc must correctly attribute the guardian's `/etc/opencode` mount to
 *     `system/guardian/`, not `config/guardian/`
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const CORE_PRINCIPLES = join(REPO_ROOT, "docs", "technical", "core-principles.md");
const CORE_ASSETS = join(REPO_ROOT, "packages", "lib", "src", "control-plane", "core-assets.ts");

describe("guardian moderation.md doc contract (fable 1.2)", () => {
  const doc = readFileSync(CORE_PRINCIPLES, "utf-8");

  test("SHIPPED_DEFAULT_HASHES does not exist in core-assets.ts (the mechanism was deleted)", () => {
    const code = readFileSync(CORE_ASSETS, "utf-8");
    expect(code).not.toContain("SHIPPED_DEFAULT_HASHES");
  });

  test("core-principles.md does not describe the deleted skip-if-user-modified mechanism", () => {
    expect(doc).not.toContain("SHIPPED_DEFAULT_HASHES");
    expect(doc).not.toContain("refreshCoreAssetsFromSource");
    expect(doc).not.toContain("byte-identical to one of the previously shipped defaults");
    expect(doc).not.toContain("guardian managed asset kept");
  });

  test("core-principles.md states moderation.md is managed / not user-editable", () => {
    expect(doc).toMatch(/moderation\.md[\s\S]{0,400}not user-editable/);
  });

  test("core-principles.md attributes the guardian's /etc/opencode mount to system/guardian/, not config/guardian/", () => {
    expect(doc).not.toContain("bind-mounted from `config/guardian/`");
    expect(doc).toContain("bind-mounted from the MANAGED `system/guardian/`");
  });

  test("core-principles.md's config/ guardian/ subtree bullet does not claim to hold moderation.md", () => {
    const configSectionMatch = doc.match(/### 1\) Config[\s\S]*?### 1b\)/);
    expect(configSectionMatch).not.toBeNull();
    const configSection = configSectionMatch![0];
    const guardianBullet = configSection.split("\n").find((line) => line.startsWith("- `guardian/`"));
    expect(guardianBullet).toBeDefined();
    expect(guardianBullet).not.toContain("instructions/moderation.md");
  });
});
