import { describe, expect, it } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFallbackBundle } from "./fallback-bundle.ts";

describe("fallback bundle validation", () => {
  it("detects missing files", () => {
    const result = validateFallbackBundle({
      composePath: "/tmp/missing-compose.yml",
      caddyPath: "/tmp/missing-caddy.json",
    });
    expect(result.ok).toBeFalse();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("flags tampered files", () => {
    const dir = mkdtempSync(join(tmpdir(), "fallback-"));
    const composePath = join(dir, "docker-compose-fallback.yml");
    const caddyPath = join(dir, "fallback-caddy.json");
    writeFileSync(composePath, "services: {}\n", "utf8");
    writeFileSync(caddyPath, "{}\n", "utf8");

    const result = validateFallbackBundle({ composePath, caddyPath });
    expect(result.ok).toBeFalse();
    expect(result.errors).toContain("compose_checksum_mismatch");
    expect(result.errors).toContain("caddy_checksum_mismatch");
  });
});
