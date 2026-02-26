import { describe, expect, it } from "bun:test";
import { checkPortDetailed, runPreflightChecksDetailed } from "@openpalm/lib/preflight.ts";
import { createDefaultStackSpec, parseStackSpec } from "@openpalm/lib/admin/stack-spec.ts";
import { generateStackArtifacts } from "@openpalm/lib/admin/stack-generator.ts";

describe("ISSUE-4 — Port 80 conflict resolution", () => {
  it("checkPortDetailed() returns null for unused port", async () => {
    const result = await checkPortDetailed(59131);
    expect(result).toBeNull();
  });

  it("runPreflightChecksDetailed() accepts a port parameter and returns typed result", async () => {
    const result = await runPreflightChecksDetailed("docker", 59132);
    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("issues");
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it("stack-spec supports ingressPort field", () => {
    const spec = parseStackSpec({
      ...createDefaultStackSpec(),
      ingressPort: 8080,
    });
    expect(spec.ingressPort).toBe(8080);
  });

  it("stack-spec rejects invalid ingressPort values", () => {
    const base = createDefaultStackSpec();
    expect(() => parseStackSpec({ ...base, ingressPort: 0 })).toThrow("invalid_ingress_port");
    expect(() => parseStackSpec({ ...base, ingressPort: 70000 })).toThrow("invalid_ingress_port");
    expect(() => parseStackSpec({ ...base, ingressPort: "80" })).toThrow("invalid_ingress_port");
  });

  it("stack-generator Caddy JSON uses spec.ingressPort", () => {
    const spec = createDefaultStackSpec();
    spec.ingressPort = 9090;
    const out = generateStackArtifacts(spec, {});
    const caddy = JSON.parse(out.caddyJson);
    expect(caddy.apps.http.servers.main.listen).toContain(":9090");
  });

  it("stack-generator defaults to port 80 when ingressPort is omitted", () => {
    const spec = createDefaultStackSpec();
    delete spec.ingressPort;
    const out = generateStackArtifacts(spec, {});
    const caddy = JSON.parse(out.caddyJson);
    expect(caddy.apps.http.servers.main.listen).toContain(":80");
  });
});
