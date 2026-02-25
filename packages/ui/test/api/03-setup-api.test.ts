import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  startServer,
  stopServer,
  authedGet,
  authedPost,
  cmd,
  rawGet,
  getTmpDir,
  claimPort,
} from "./helpers";

claimPort(2);

describe("setup wizard API (sequential, modifies state)", () => {
  beforeAll(async () => {
    await startServer();
  });

  afterAll(() => {
    stopServer();
  });

  it('POST setup step "welcome" marks complete', async () => {
    const res = await authedPost("/setup/step", { step: "welcome" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.steps.welcome).toBe(true);
  });

  it('POST setup step "bogus" returns 400', async () => {
    const res = await authedPost("/setup/step", { step: "bogus" });
    expect(res.status).toBe(400);
  });

  it("POST setup/profile saves name/email", async () => {
    const res = await cmd("setup.profile", {
      name: "Taylor Palm",
      email: "taylor@example.com",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.profile.name).toBe("Taylor Palm");
    expect(body.data.profile.email).toBe("taylor@example.com");
  });

  it('POST setup step "profile" marks complete', async () => {
    const res = await authedPost("/setup/step", { step: "profile" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.steps.profile).toBe(true);
  });

  it("POST setup/service-instances saves config", async () => {
    const res = await authedPost("/setup/service-instances", {
      openmemory: "http://test:8765",
      psql: "",
      qdrant: "",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('POST setup step "serviceInstances" marks complete', async () => {
    const res = await authedPost("/setup/step", { step: "serviceInstances" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.steps.serviceInstances).toBe(true);
  });

  it('POST setup step "security" marks complete', async () => {
    const res = await authedPost("/setup/step", { step: "security" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.steps.security).toBe(true);
  });

  it("POST setup/channels with channel-chat saves", async () => {
    const res = await authedPost("/setup/channels", {
      channels: ["channel-chat"],
      channelConfigs: { "channel-chat": { CHAT_INBOUND_TOKEN: "test-token" } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('POST setup step "channels" marks complete', async () => {
    const res = await authedPost("/setup/step", { step: "channels" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.steps.channels).toBe(true);
  });

  it('POST setup/access-scope "host" saves', async () => {
    const res = await authedPost("/setup/access-scope", { scope: "host" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.accessScope).toBe("host");
  });

  it('POST setup/access-scope "internet" returns 400', async () => {
    const res = await authedPost("/setup/access-scope", { scope: "internet" });
    expect(res.status).toBe(400);
  });

  it('POST setup step "healthCheck" marks complete', async () => {
    const res = await authedPost("/setup/step", { step: "healthCheck" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.steps.healthCheck).toBe(true);
  });

  it("GET setup/health-check returns services with admin.ok", async () => {
    const res = await rawGet("/setup/health-check");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.services).toBeDefined();
    expect(body.services.admin.ok).toBe(true);
  });

  it("POST setup/complete marks setup as complete", async () => {
    const res = await authedPost("/setup/complete", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.completed).toBe(true);
  });

  it("setup/complete writes docker-compose.yml with required services", () => {
    const composePath = join(getTmpDir(), "state", "docker-compose.yml");
    expect(existsSync(composePath)).toBe(true);
    const content = readFileSync(composePath, "utf8");
    expect(content).toContain("services:");
    expect(content).toContain("assistant:");
    expect(content).toContain("gateway:");
  });

  it("setup/complete writes caddy.json with route entries", () => {
    const caddyPath = join(getTmpDir(), "state", "caddy.json");
    expect(existsSync(caddyPath)).toBe(true);
    const content = readFileSync(caddyPath, "utf8");
    const parsed = JSON.parse(content);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
  });

  it("setup/complete writes runtime .env with OPENPALM_STATE_HOME", () => {
    const envPath = join(getTmpDir(), "state", ".env");
    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("OPENPALM_STATE_HOME=");
  });

  it("setup/complete writes system.env with access scope", () => {
    const sysEnvPath = join(getTmpDir(), "state", "system.env");
    expect(existsSync(sysEnvPath)).toBe(true);
    const content = readFileSync(sysEnvPath, "utf8");
    expect(content).toContain("OPENPALM_ACCESS_SCOPE=");
  });

  it("setup/complete writes gateway/.env", () => {
    const gwEnvPath = join(getTmpDir(), "state", "gateway", ".env");
    expect(existsSync(gwEnvPath)).toBe(true);
  });

  it("setup/complete writes secrets.env with POSTGRES_PASSWORD", () => {
    const secretsPath = join(getTmpDir(), "config", "secrets.env");
    expect(existsSync(secretsPath)).toBe(true);
    const content = readFileSync(secretsPath, "utf8");
    expect(content).toContain("POSTGRES_PASSWORD=");
  });

  it("setup/complete writes openpalm.yaml stack spec", () => {
    const specPath = join(getTmpDir(), "config", "openpalm.yaml");
    expect(existsSync(specPath)).toBe(true);
    const content = readFileSync(specPath, "utf8");
    expect(content.length).toBeGreaterThan(0);
  });

  it("GET setup/status now shows completed: true", async () => {
    const res = await authedGet("/setup/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.completed).toBe(true);
  });

  it("GET setup/status without auth returns 401 after completion", async () => {
    const res = await rawGet("/setup/status");
    expect(res.status).toBe(401);
  });
});
