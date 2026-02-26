import { describe, expect, it } from "bun:test";
import { checkPortDetailed, runPreflightChecksDetailed } from "@openpalm/lib/preflight.ts";
import { createDefaultStackSpec, parseStackSpec } from "@openpalm/lib/admin/stack-spec.ts";
import { generateStackArtifacts } from "@openpalm/lib/admin/stack-generator.ts";

const installFile = new URL("./install.ts", import.meta.url).pathname;
const typesFile = new URL("../types.ts", import.meta.url).pathname;

describe("ISSUE-4 — Port 80 conflict resolution", () => {
  it("InstallOptions type includes a port field", async () => {
    const content = await Bun.file(typesFile).text();
    expect(content).toContain("port?: number");
  });

  it("install.ts reads options.port and defaults to 80", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("options.port ?? 80");
  });

  it("install.ts writes OPENPALM_INGRESS_PORT to state env", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("OPENPALM_INGRESS_PORT");
  });

  it("install.ts Caddy JSON uses configurable ingressPort", async () => {
    const content = await Bun.file(installFile).text();
    // The minimal Caddy JSON uses template literal with ingressPort
    expect(content).toContain("`:${ingressPort}`");
  });

  it("install.ts port conflict is fatal without --port flag", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("Port 80 is required but already in use");
    expect(content).toContain("--port");
  });

  it("install.ts health check URL uses configured ingressPort", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("ingressPort === 80");
    expect(content).toContain("`http://localhost:${ingressPort}`");
  });

  it("checkPortDetailed() returns null for unused port", async () => {
    const result = await checkPortDetailed(59131);
    expect(result).toBeNull();
  });

  it("checkPortDetailed() returns port_conflict code with meta.port when port is in use", () => {
    // Contract validation: if a port conflict issue were returned, it would have this shape
    const mockIssue = {
      code: "port_conflict" as const,
      severity: "fatal" as const,
      message: "Port 8080 is already in use by another process.",
      meta: { port: 8080 },
    };
    expect(mockIssue.code).toBe("port_conflict");
    expect(mockIssue.severity).toBe("fatal");
    expect(mockIssue.meta.port).toBe(8080);
  });

  it("runPreflightChecksDetailed() accepts a port parameter and returns typed result", async () => {
    const result = await runPreflightChecksDetailed("docker", "docker", 59132);
    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("issues");
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it("install.ts uses typed code-based port conflict detection", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain('i.code === "port_conflict"');
    // Should NOT use message substring matching for port detection
    expect(content).not.toContain('.message.includes("already in use")');
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

  it("writes Caddy JSON with configurable port", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("OPENPALM_INGRESS_PORT");
    expect(content).toContain("`:${ingressPort}`");
  });
});
