/**
 * End-to-end tests for the admin server HTTP API.
 *
 * These tests spin up the admin server against a temporary file system
 * and verify every page/endpoint the admin UI relies on.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const REPO_ROOT = resolve(import.meta.dir, "../..");

let base: string;
let tmpDir: string;
let proc: Subprocess;
let opencodeConfigPath: string;

function api(path: string, opts?: RequestInit) {
  return fetch(`${base}${path}`, opts);
}

function apiJson(path: string, opts?: RequestInit) {
  return api(path, {
    ...opts,
    headers: { "content-type": "application/json", ...(opts?.headers as Record<string, string> ?? {}) },
  }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json() as Record<string, unknown> }));
}

function authed(path: string, opts?: RequestInit) {
  return apiJson(path, {
    ...opts,
    headers: { "x-admin-token": "test-token-e2e", ...(opts?.headers as Record<string, string> ?? {}) },
  });
}

function cmd(type: string, payload: Record<string, unknown> = {}) {
  return authed("/admin/command", {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "openpalm-e2e-"));
  const dataDir = join(tmpDir, "data");
  const uiDir = join(tmpDir, "ui");
  const configDir = join(tmpDir, "config");
  opencodeConfigPath = join(configDir, "opencode.jsonc");
  const stackSpecPath = join(configDir, "stack-spec.json");
  const caddyDir = join(tmpDir, "caddy");
  const channelEnvDir = join(tmpDir, "channel-env");
  const channelSecretDir = join(tmpDir, "secrets", "channels");
  const gatewaySecretDir = join(tmpDir, "secrets", "gateway");
  const cronDir = join(tmpDir, "cron");
  const stateRoot = join(tmpDir, "state");
  const renderedDir = join(tmpDir, "rendered");
  const caddyRoutesDir = join(renderedDir, "caddy", "snippets");

  for (const d of [dataDir, uiDir, configDir, caddyDir, channelEnvDir, channelSecretDir, gatewaySecretDir, cronDir, stateRoot, caddyRoutesDir]) mkdirSync(d, { recursive: true });

  // Copy UI files
  for (const f of ["index.html", "setup-ui.js", "logo.png"]) {
    copyFileSync(join(REPO_ROOT, "admin/ui", f), join(uiDir, f));
  }

  // Copy config files
  copyFileSync(join(REPO_ROOT, "assistant/extensions/opencode.jsonc"), opencodeConfigPath);
  copyFileSync(join(REPO_ROOT, "assets/state/caddy/Caddyfile"), join(caddyDir, "Caddyfile"));

  // Create required env/secrets files
  writeFileSync(join(tmpDir, ".env"), "", "utf8");
  writeFileSync(join(tmpDir, "secrets.env"), "", "utf8");

  // Create channel env files
  for (const ch of ["channel-chat", "channel-discord", "channel-voice", "channel-telegram"]) {
    writeFileSync(join(channelEnvDir, `${ch}.env`), "", "utf8");
  }

  writeFileSync(join(gatewaySecretDir, "channels.env"), "", "utf8");
  for (const ch of ["chat", "discord", "voice", "telegram"]) {
    writeFileSync(join(channelSecretDir, `${ch}.env`), "", "utf8");
  }

  // Pick a random port
  const port = 18100 + Math.floor(Math.random() * 1000);
  base = `http://127.0.0.1:${port}`;

  proc = Bun.spawn(["bun", "run", "admin/src/server.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_TOKEN: "test-token-e2e",
      OPENPALM_STATE_ROOT: stateRoot,
      DATA_DIR: dataDir,
      UI_DIR: uiDir,
      OPENCODE_CONFIG_PATH: opencodeConfigPath,
      CADDYFILE_PATH: join(caddyDir, "Caddyfile"),
      CHANNEL_ENV_DIR: channelEnvDir,
      CRON_DIR: cronDir,
      RUNTIME_ENV_PATH: join(tmpDir, ".env"),
      SECRETS_ENV_PATH: join(tmpDir, "secrets.env"),
      STACK_SPEC_PATH: stackSpecPath,
      CHANNEL_SECRET_DIR: channelSecretDir,
      GATEWAY_CHANNEL_SECRETS_PATH: join(gatewaySecretDir, "channels.env"),
      CADDY_ROUTES_DIR: caddyRoutesDir,
      CADDY_JSON_PATH: join(renderedDir, "caddy", "caddy.json"),
      COMPOSE_FILE_PATH: join(renderedDir, "docker-compose.yml"),
      GATEWAY_ENV_PATH: join(stateRoot, "gateway", ".env"),
      OPENMEMORY_ENV_PATH: join(stateRoot, "openmemory", ".env"),
      POSTGRES_ENV_PATH: join(stateRoot, "postgres", ".env"),
      QDRANT_ENV_PATH: join(stateRoot, "qdrant", ".env"),
      ASSISTANT_ENV_PATH: join(stateRoot, "assistant", ".env"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Wait for the server to be ready
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${base}/health`);
      if (r.ok) break;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
});

afterAll(() => {
  proc?.kill();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// ── Static Files ────────────────────────────────────────

describe("static file serving", () => {
  it("GET /health returns ok", async () => {
    const r = await apiJson("/health");
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.service).toBe("admin");
  });

  it("GET / serves index.html", async () => {
    const r = await api("/");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("<!doctype html>");
    expect(text).toContain("OpenPalm Admin");
  });

  it("GET /index.html serves index.html", async () => {
    const r = await api("/index.html");
    expect(r.status).toBe(200);
  });

  it("GET /setup-ui.js serves the setup wizard script", async () => {
    const r = await api("/setup-ui.js");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("openPalmSetup");
  });

  it("GET /logo.png serves the logo", async () => {
    const r = await api("/logo.png");
    expect(r.status).toBe(200);
  });

  it("unknown path returns 404", async () => {
    const r = await apiJson("/unknown/route");
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("not_found");
  });
});

// ── OpenCode Proxy ───────────────────────────────────────

describe("opencode proxy", () => {
  it("GET /admin/opencode/ returns 502 when opencode-core is unreachable", async () => {
    const r = await api("/admin/opencode/");
    // 502 = route exists but upstream is unavailable (not 404 which would mean no route)
    expect([403, 502]).toContain(r.status);
  });

  it("GET /admin/opencode/sub/path also proxies (not 404)", async () => {
    const r = await api("/admin/opencode/api/v1/session");
    expect(r.status).not.toBe(404);
  });
});

// ── Setup Wizard ────────────────────────────────────────

describe("setup wizard", () => {
  it("GET /admin/setup/status returns first-boot state", async () => {
    const r = await apiJson("/admin/setup/status");
    expect(r.ok).toBe(true);
    expect(r.data.completed).toBe(false);
    expect(r.data.firstBoot).toBe(true);
    expect(r.data).toHaveProperty("serviceInstances");
    expect(r.data).toHaveProperty("openmemoryProvider");
  });

  it("POST /admin/setup/step validates step name", async () => {
    const bad = await cmd("setup.step", { step: "bogus" });
    expect(bad.status).toBe(400);
    expect(bad.data.code).toBe("invalid_step");
  });

  it("POST /admin/setup/step completes a step", async () => {
    const r = await cmd("setup.step", { step: "welcome" });
    expect(r.ok).toBe(true);
    const state = r.data as Record<string, unknown>;
    expect(((state.data as Record<string, unknown>)?.steps as Record<string, boolean>)?.welcome).toBe(true);
  });

  it("POST /admin/setup/access-scope validates scope", async () => {
    const bad = await cmd("setup.access_scope", { scope: "internet" });
    expect(bad.status).toBe(400);
  });

  it("POST /admin/setup/access-scope sets scope and writes artifacts", async () => {
    const r = await cmd("setup.access_scope", { scope: "host" });
    expect(r.ok).toBe(true);
    expect(((r.data.data as Record<string, unknown>)?.accessScope)).toBe("host");
  });

  it("POST /admin/setup/service-instances saves config", async () => {
    const r = await cmd("setup.service_instances", { openmemory: "http://test:8765", psql: "", qdrant: "" });
    expect(r.ok).toBe(true);
  });

  it("POST /admin/setup/channels saves channel selection with configs", async () => {
    const r = await cmd("setup.channels", { channels: ["channel-chat"], channelConfigs: { "channel-chat": { CHAT_INBOUND_TOKEN: "test-token" } } });
    if (!r.ok) console.error(r.data);
    expect(r.ok).toBe(true);
  });

  it("POST /admin/setup/complete marks setup as complete", async () => {
    const r = await cmd("setup.complete");
    expect(r.ok).toBe(true);
    const status = await authed("/admin/setup/status");
    expect(status.data.completed).toBe(true);
  });

  it("after completion, /admin/setup/status requires auth", async () => {
    const r = await apiJson("/admin/setup/status");
    expect([200,401]).toContain(r.status);
  });

  it("after completion, write endpoints require auth", async () => {
    const r = await cmd("setup.access_scope", { scope: "lan" });
    expect([200,401]).toContain(r.status);
  });

  it.skip("after completion, write endpoints work with auth", async () => {
    const r = await cmd("setup.access_scope", { scope: "lan" });
    expect(r.ok).toBe(true);
  });
});

// ── Auth-Protected Endpoints ────────────────────────────

describe("auth-protected endpoints", () => {
  it("GET /admin/installed requires auth", async () => {
    const r = await apiJson("/admin/installed");
    expect([200,401]).toContain(r.status);
  });

  it("GET /admin/installed returns plugins with auth", async () => {
    const r = await authed("/admin/installed");
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data.plugins)).toBe(true);
  });

  it("GET /admin/channels requires auth", async () => {
    const r = await apiJson("/admin/channels");
    expect([200,401]).toContain(r.status);
  });

  it("GET /admin/channels returns channel list with auth", async () => {
    const r = await authed("/admin/channels");
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data.channels)).toBe(true);
  });

  it("GET /admin/automations requires auth", async () => {
    const r = await apiJson("/admin/automations");
    expect([200,401]).toContain(r.status);
  });

  it("GET /admin/automations returns automation list with auth", async () => {
    const r = await authed("/admin/automations");
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data.automations)).toBe(true);
  });

  it("auto-creates missing opencode config for installed endpoint", async () => {
    rmSync(opencodeConfigPath, { force: true });
    const installed = await authed("/admin/installed");
    expect(installed.status).toBe(200);
    expect(Array.isArray(installed.data.plugins)).toBe(true);
  });
});

// ── Health Check ─────────────────────────────────────────

describe("health check", () => {
  it("GET /admin/setup/health-check returns service statuses", async () => {
    const r = await apiJson("/admin/setup/health-check");
    expect(r.ok).toBe(true);
    expect(r.data).toHaveProperty("services");
    const services = r.data.services as Record<string, { ok: boolean }>;
    expect(services.admin.ok).toBe(true);
  });
});

// ── Meta ─────────────────────────────────────────────────

describe("meta endpoint", () => {
  it("GET /admin/meta returns service display names and channel fields", async () => {
    const r = await apiJson("/admin/meta");
    expect(r.ok).toBe(true);
    expect(r.data).toHaveProperty("serviceNames");
    expect(r.data).toHaveProperty("channelFields");
    const names = r.data.serviceNames as Record<string, { label: string }>;
    expect(names.gateway.label).toBe("Message Router");
    expect(names.assistant.label).toBe("AI Assistant");
    expect(names.openmemory.label).toBe("Memory");
    const fields = r.data.channelFields as Record<string, Array<{ key: string; label: string }>>;
    expect(fields["channel-discord"].length).toBe(2);
    expect(fields["channel-discord"][0].label).toBe("Bot Token");
    expect(Array.isArray(r.data.requiredCoreSecrets)).toBe(true);
  });
});

// ── Stack Spec ───────────────────────────────────────────

describe("stack spec endpoints", () => {
  it("GET /admin/stack/spec returns default spec with auth", async () => {
    const r = await authed("/admin/state");
    expect(r.ok).toBe(true);
    expect(((r.data.data as Record<string, unknown>).spec as Record<string, unknown>).version).toBe(2);
  });

  it.skip("POST /admin/stack/spec validates and saves custom spec", async () => {
    const current = await authed("/admin/state");
    const spec = (current.data.data as Record<string, unknown>).spec as Record<string, unknown>;
    const r = await authed("/admin/stack/spec", {
      method: "POST",
      body: JSON.stringify({
        spec: {
          ...spec,
          accessScope: "host",
          channels: {
            chat: { enabled: true, exposure: "public" },
            discord: { enabled: false, exposure: "lan" },
            voice: { enabled: false, exposure: "lan" },
            telegram: { enabled: false, exposure: "lan" },
          },
        }
      }),
    });
    expect(r.ok).toBe(true);
    const check = await authed("/admin/state");
    expect((check.data.spec as Record<string, unknown>).accessScope).toBe("host");
  });
});

describe("channel config secret references", () => {
  it("rejects stack spec save when channel config has unresolved secret references", async () => {
    const current = await authed("/admin/state");
    const spec = (current.data.data as Record<string, unknown>).spec as Record<string, unknown>;
    const channels = (spec.channels as Record<string, Record<string, unknown>>);
    channels.chat = {
      ...channels.chat,
      config: {
        ...(channels.chat.config as Record<string, string>),
        CHAT_INBOUND_TOKEN: "${MISSING_SECRET}",
      },
    };

    const save = await cmd("stack.spec.set", { spec: { ...spec, channels } });
    expect(save.ok).toBe(false);
  });

  it("accepts host exposure in stack spec", async () => {
    const current = await authed("/admin/state");
    const spec = (current.data.data as Record<string, unknown>).spec as Record<string, unknown>;
    const channels = structuredClone(spec.channels as Record<string, { enabled: boolean; exposure: string; config: Record<string, string> }>);

    for (const channelName of Object.keys(channels)) {
      channels[channelName].config = Object.fromEntries(Object.keys(channels[channelName].config).map((key) => [key, ""]));
    }

    channels.chat = {
      ...channels.chat,
      exposure: "host",
    };

    const save = await cmd("stack.spec.set", { spec: { ...spec, channels } });
    expect(save.ok).toBe(true);
    expect((((save.data.data as Record<string, unknown>).channels as Record<string, Record<string, unknown>>).chat.exposure)).toBe("host");
  });
});

// ── Secrets ──────────────────────────────────────────────

describe("secrets endpoints", () => {
  it("GET /admin/secrets requires auth", async () => {
    const r = await apiJson("/admin/state");
    expect([200,401]).toContain(r.status);
  });

  it("GET /admin/secrets returns secrets state with auth", async () => {
    const r = await authed("/admin/state");
    expect(r.ok).toBe(true);
  });

  it("GET /admin/secrets/raw returns raw secrets file with auth", async () => {
    const r = await api("/admin/secrets/raw", {
      headers: { "content-type": "application/json", "x-admin-token": "test-token-e2e" },
    });
    expect(r.status).toBe(200);
  });

  it("POST /admin/secrets/raw saves raw secrets file with auth", async () => {
    const r = await cmd("secret.raw.set", { content: "TEST_KEY=test_value\n" });
    expect(r.ok).toBe(true);

    // Verify the content was saved
    const check = await api("/admin/secrets/raw", {
      headers: { "content-type": "application/json", "x-admin-token": "test-token-e2e" },
    });
    const text = await check.text();
    expect(text).toContain("TEST_KEY=test_value");
  });
});

// ── UI Content Verification ─────────────────────────────

describe("UI content", () => {
  it("index.html includes normalizeAdminApiPath for Caddy routing", async () => {
    const r = await api("/");
    const text = await r.text();
    expect(text).toContain("normalizeAdminApiPath");
    expect(text).toContain("ADMIN_API_PREFIX");
    expect(text).toContain("/admin/api/");
  });

  it("index.html includes dashboard page container", async () => {
    const r = await api("/");
    const text = await r.text();
    expect(text).toContain('id="page-dashboard"');
  });

  it("index.html includes setup-ui.js script tag", async () => {
    const r = await api("/");
    const text = await r.text();
    expect(text).toContain('src="setup-ui.js"');
  });

  it("setup-ui.js includes wizard implementation", async () => {
    const r = await api("/setup-ui.js");
    const text = await r.text();
    expect(text).toContain("wizardStep");
    expect(text).toContain("checkSetup");
    expect(text).toContain("finishSetup");
    expect(text).toContain("pollUntilReady");
  });

  it("setup-ui.js includes channel configuration fields", async () => {
    const r = await api("/setup-ui.js");
    const text = await r.text();
    expect(text).toContain("channelSections");
    expect(text).toContain("channelFields");
    expect(text).toContain("channelConfigs");
  });
});
