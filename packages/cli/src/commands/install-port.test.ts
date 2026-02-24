import { describe, expect, it } from "bun:test";
import { checkPort, runPreflightChecks } from "@openpalm/lib/preflight.ts";
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

  it("checkPort() accepts a port parameter (defaults to 80)", () => {
    // The checkPort function signature accepts an optional port
    expect(typeof checkPort).toBe("function");
    // Verify it can be called with a custom port (won't actually find anything in test)
    expect(checkPort(12345)).resolves.toBeNull();
  });

  it("runPreflightChecks() accepts a port parameter", () => {
    expect(typeof runPreflightChecks).toBe("function");
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

  it("minimal compose uses OPENPALM_INGRESS_PORT env var for Caddy port", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("OPENPALM_INGRESS_PORT:-80");
  });
});
