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
  getBaseUrl,
  getTmpDir,
  claimPort,
} from "./helpers";

claimPort(2);

/**
 * Setup wizard API — complete flow from first boot to finished.
 *
 * These tests exercise a single sequential workflow: walking the setup wizard
 * from a fresh state to completion, then verifying generated artifacts. Each
 * phase depends on the prior one succeeding, so they are grouped into a small
 * number of honest test blocks rather than 23 independently-named tests that
 * would cascade-fail if any early step broke.
 *
 * Phase grouping:
 *   1. configure  — walk every wizard step, accumulate server state
 *   2. complete   — call /setup/complete to generate all artifacts
 *   3. verify     — assert on generated files and post-completion API behavior
 */
describe("setup wizard API", () => {
  beforeAll(async () => {
    await startServer();
  });

  afterAll(() => {
    stopServer();
  });

	it("enforces local-only setup access from trusted client address", async () => {
		const localRes = await rawGet("/setup/status");
		expect(localRes.status).toBe(200);

		const proxiedPublicRes = await fetch(`${getBaseUrl()}/setup/status`, {
			headers: {
				"x-forwarded-for": "203.0.113.10"
			}
		});
		expect(proxiedPublicRes.status).toBe(403);
	});

  // ── Phase 1: Walk every wizard step to build up server state ──
  it("configures the setup wizard through all steps", async () => {
    // Welcome
    {
      const res = await authedPost("/setup/step", { step: "welcome" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.state.steps.welcome).toBe(true);
    }

    // Invalid step returns 400
    {
      const res = await authedPost("/setup/step", { step: "bogus" });
      expect(res.status).toBe(400);
    }

    // Profile data
    {
      const res = await cmd("setup.profile", {
        name: "Taylor Palm",
        email: "taylor@example.com",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.data.profile.name).toBe("Taylor Palm");
      expect(body.data.profile.email).toBe("taylor@example.com");
    }

    // Mark profile complete
    {
      const res = await authedPost("/setup/step", { step: "profile" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.state.steps.profile).toBe(true);
    }

    // Service instances
    {
      const res = await authedPost("/setup/service-instances", {
        openmemory: "http://test:8765",
        psql: "",
        qdrant: "",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    }

    // Mark serviceInstances complete
    {
      const res = await authedPost("/setup/step", {
        step: "serviceInstances",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.state.steps.serviceInstances).toBe(true);
    }

    // Security
    {
      const res = await authedPost("/setup/step", { step: "security" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.state.steps.security).toBe(true);
    }

    // Channels
    {
      const res = await authedPost("/setup/channels", {
        channels: ["channel-chat"],
        channelConfigs: {
          "channel-chat": { CHAT_INBOUND_TOKEN: "test-token" },
        },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    }

    // Mark channels complete
    {
      const res = await authedPost("/setup/step", { step: "channels" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.state.steps.channels).toBe(true);
    }

    // Access scope — valid
    {
      const res = await authedPost("/setup/access-scope", { scope: "host" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.state.accessScope).toBe("host");
    }

    // Access scope — invalid returns 400
    {
      const res = await authedPost("/setup/access-scope", {
        scope: "internet",
      });
      expect(res.status).toBe(400);
    }

    // Health check step
    {
      const res = await authedPost("/setup/step", { step: "healthCheck" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.state.steps.healthCheck).toBe(true);
    }

    // Health check endpoint
    {
      const res = await rawGet("/setup/health-check");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.services).toBeDefined();
      expect(body.services.admin.ok).toBe(true);
    }
  });

  // ── Phase 2: Complete setup and generate artifacts ──
  it("completes setup and generates all artifacts", async () => {
    const legacyStartCore = await cmd("setup.start_core", {});
    expect(legacyStartCore.status).toBe(400);
    const legacyBody = await legacyStartCore.json();
    expect(legacyBody.ok).toBe(false);
    expect(legacyBody.code).toBe("unknown_command");

    const res = await authedPost("/setup/complete", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.completed).toBe(true);

    const legacyStartCoreAfterComplete = await cmd("setup.start_core", {});
    expect(legacyStartCoreAfterComplete.status).toBe(400);
    const legacyAfterCompleteBody = await legacyStartCoreAfterComplete.json();
    expect(legacyAfterCompleteBody.ok).toBe(false);
    expect(legacyAfterCompleteBody.code).toBe("unknown_command");
  });

  // ── Phase 3: Verify generated files and post-completion behavior ──
  it("generated artifacts and post-completion behavior are correct", async () => {
    const tmp = getTmpDir();

    // docker-compose.yml
    {
      const composePath = join(tmp, "state", "docker-compose.yml");
      expect(existsSync(composePath)).toBe(true);
      const content = readFileSync(composePath, "utf8");
      expect(content).toContain("services:");
      expect(content).toContain("assistant:");
      expect(content).toContain("gateway:");
    }

    // caddy.json
    {
      const caddyPath = join(tmp, "state", "caddy.json");
      expect(existsSync(caddyPath)).toBe(true);
      const content = readFileSync(caddyPath, "utf8");
      const parsed = JSON.parse(content);
      expect(parsed).toBeDefined();
      expect(typeof parsed).toBe("object");
    }

    // runtime .env
    {
      const envPath = join(tmp, "state", ".env");
      expect(existsSync(envPath)).toBe(true);
      const content = readFileSync(envPath, "utf8");
      expect(content).toContain("OPENPALM_STATE_HOME=");
    }

    // system.env
    {
      const sysEnvPath = join(tmp, "state", "system.env");
      expect(existsSync(sysEnvPath)).toBe(true);
      const content = readFileSync(sysEnvPath, "utf8");
      expect(content).toContain("OPENPALM_ACCESS_SCOPE=");
    }

    // gateway/.env
    {
      const gwEnvPath = join(tmp, "state", "gateway", ".env");
      expect(existsSync(gwEnvPath)).toBe(true);
    }

    // secrets.env
    {
      const secretsPath = join(tmp, "config", "secrets.env");
      expect(existsSync(secretsPath)).toBe(true);
      const content = readFileSync(secretsPath, "utf8");
      expect(content).toContain("POSTGRES_PASSWORD=");
    }

    // openpalm.yaml
    {
      const specPath = join(tmp, "config", "openpalm.yaml");
      expect(existsSync(specPath)).toBe(true);
      const content = readFileSync(specPath, "utf8");
      expect(content.length).toBeGreaterThan(0);
    }

    // GET setup/status shows completed: true
    {
      const res = await authedGet("/setup/status");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.completed).toBe(true);
    }

    // GET setup/status without auth returns 401 after completion
    {
      const res = await rawGet("/setup/status");
      expect(res.status).toBe(401);
    }
  });
});
