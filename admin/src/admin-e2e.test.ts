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
      STATE_ROOT: stateRoot,
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
    const bad = await apiJson("/admin/setup/step", {
      method: "POST",
      body: JSON.stringify({ step: "bogus" }),
    });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toBe("invalid step");
  });

  it("POST /admin/setup/step completes a step", async () => {
    const r = await apiJson("/admin/setup/step", {
      method: "POST",
      body: JSON.stringify({ step: "welcome" }),
    });
    expect(r.ok).toBe(true);
    const state = r.data as Record<string, unknown>;
    expect(((state.state as Record<string, unknown>)?.steps as Record<string, boolean>)?.welcome).toBe(true);
  });

  it("POST /admin/setup/access-scope validates scope", async () => {
    const bad = await apiJson("/admin/setup/access-scope", {
      method: "POST",
      body: JSON.stringify({ scope: "internet" }),
    });
    expect(bad.status).toBe(400);
  });

  it.skip("POST /admin/setup/access-scope sets scope", async () => {
    const r = await apiJson("/admin/setup/access-scope", {
      method: "POST",
      body: JSON.stringify({ scope: "host" }),
    });
    expect(r.ok).toBe(true);
  });

  it("POST /admin/setup/service-instances saves config", async () => {
    const r = await apiJson("/admin/setup/service-instances", {
      method: "POST",
      body: JSON.stringify({ openmemory: "http://test:8765", psql: "", qdrant: "" }),
    });
    expect(r.ok).toBe(true);
  });

  it("POST /admin/setup/channels saves channel selection", async () => {
    const r = await apiJson("/admin/setup/channels", {
      method: "POST",
      body: JSON.stringify({ channels: ["channel-chat"] }),
    });
    expect(r.ok).toBe(true);
  });

  it("POST /admin/setup/complete marks setup as complete", async () => {
    const r = await apiJson("/admin/setup/complete", { method: "POST" });
    expect(r.ok).toBe(true);
    const status = await authed("/admin/setup/status");
    expect(status.data.completed).toBe(true);
  });

  it("after completion, /admin/setup/status requires auth", async () => {
    const r = await apiJson("/admin/setup/status");
    expect(r.status).toBe(401);
  });

  it("after completion, write endpoints require auth", async () => {
    const r = await apiJson("/admin/setup/access-scope", {
      method: "POST",
      body: JSON.stringify({ scope: "lan" }),
    });
    expect(r.status).toBe(401);
  });

  it.skip("after completion, write endpoints work with auth", async () => {
    const r = await authed("/admin/setup/access-scope", {
      method: "POST",
      body: JSON.stringify({ scope: "lan" }),
    });
    expect(r.ok).toBe(true);
  });
});

// ── Plugin Management ───────────────────────────────────

describe("plugin management", () => {
  it("POST /admin/plugins/install requires auth", async () => {
    const r = await apiJson("/admin/plugins/install", { method: "POST", body: JSON.stringify({ pluginId: "@scope/test" }) });
    expect(r.status).toBe(401);
  });

  it("POST /admin/plugins/install installs plugin with auth", async () => {
    const r = await apiJson("/admin/plugins/install", {
      method: "POST",
      headers: { "x-admin-token": "test-token-e2e" },
      body: JSON.stringify({ pluginId: "@scope/test" })
    });
    expect(r.ok).toBe(true);
  });

  it("POST /admin/plugins/uninstall uninstalls plugin with auth", async () => {
    const r = await apiJson("/admin/plugins/uninstall", {
      method: "POST",
      headers: { "x-admin-token": "test-token-e2e" },
      body: JSON.stringify({ pluginId: "@scope/test" })
    });
    expect(r.ok).toBe(true);
  });
});

describe("auth-protected endpoints", () => {
  it("GET /admin/installed requires auth", async () => {
    const r = await apiJson("/admin/installed");
    expect(r.status).toBe(401);
  });

  it("GET /admin/installed returns plugins with auth", async () => {
    const r = await authed("/admin/installed");
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data.plugins)).toBe(true);
  });

  it("GET /admin/channels requires auth", async () => {
    const r = await apiJson("/admin/channels");
    expect(r.status).toBe(401);
  });

  it("GET /admin/channels returns channel list with auth", async () => {
    const r = await authed("/admin/channels");
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data.channels)).toBe(true);
  });

  it("GET /admin/automations requires auth", async () => {
    const r = await apiJson("/admin/automations");
    expect(r.status).toBe(401);
  });

  it("GET /admin/automations returns automation list with auth", async () => {
    const r = await authed("/admin/automations");
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data.automations)).toBe(true);
  });

  it("GET /admin/config requires auth", async () => {
    const r = await api("/admin/config");
    expect(r.status).toBe(401);
  });

  it("GET /admin/config returns config with auth", async () => {
    const r = await api("/admin/config", {
      headers: { "x-admin-token": "test-token-e2e" },
    });
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("$schema");
  });

  it("auto-creates missing opencode config for installed/config endpoints", async () => {
    rmSync(opencodeConfigPath, { force: true });

    const installed = await authed("/admin/installed");
    expect(installed.status).toBe(200);
    expect(Array.isArray(installed.data.plugins)).toBe(true);

    const cfg = await api("/admin/config", {
      headers: { "x-admin-token": "test-token-e2e" },
    });
    expect(cfg.status).toBe(200);
    const text = await cfg.text();
    expect(text).toContain("{");
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

describe("system state endpoint", () => {
  it("GET /admin/system/state returns consolidated setup, stack, and secrets", async () => {
    const r = await authed("/admin/system/state");
    expect(r.ok).toBe(true);
    expect(r.data).toHaveProperty("setup");
    expect(r.data).toHaveProperty("stack");
    expect(r.data).toHaveProperty("secrets");
  });
});

describe("stack spec endpoints", () => {
  it("GET /admin/stack/spec returns default spec with auth", async () => {
    const r = await authed("/admin/stack/spec");
    expect(r.ok).toBe(true);
    expect((r.data.spec as Record<string, unknown>).version).toBe(2);
  });

  it.skip("POST /admin/stack/spec validates and saves custom spec", async () => {
    const current = await authed("/admin/stack/spec");
    const spec = current.data.spec as Record<string, unknown>;
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
    const check = await authed("/admin/stack/spec");
    expect((check.data.spec as Record<string, unknown>).accessScope).toBe("host");
  });

  it("GET /admin/stack/render returns generated caddyfile", async () => {
    const r = await authed("/admin/stack/render");
    expect(r.ok).toBe(true);
    const generated = r.data.generated as Record<string, unknown>;
    expect(typeof generated.caddyfile).toBe("string");
    expect(generated.caddyfile as string).toContain(":80 {");
  });
});

describe("channel config secret references", () => {
  it("rejects stack spec save when channel config has unresolved secret references", async () => {
    const current = await authed("/admin/stack/spec");
    const spec = current.data.spec as Record<string, unknown>;
    const channels = (spec.channels as Record<string, Record<string, unknown>>);
    channels.chat = {
      ...channels.chat,
      config: {
        ...(channels.chat.config as Record<string, string>),
        CHAT_INBOUND_TOKEN: "${MISSING_SECRET}",
      },
    };

    const save = await authed("/admin/stack/spec", {
      method: "POST",
      body: JSON.stringify({ spec: { ...spec, channels } }),
    });
    expect(save.ok).toBe(false);
  });

  it("accepts host exposure in stack spec", async () => {
    const current = await authed("/admin/stack/spec");
    const spec = current.data.spec as Record<string, unknown>;
    const channels = structuredClone(spec.channels as Record<string, { enabled: boolean; exposure: string; config: Record<string, string> }>);

    for (const channel of ["chat", "discord", "voice", "telegram"] as const) {
      channels[channel].config = Object.fromEntries(Object.keys(channels[channel].config).map((key) => [key, ""]));
    }

    channels.chat = {
      ...channels.chat,
      exposure: "host",
    };

    const save = await authed("/admin/stack/spec", {
      method: "POST",
      body: JSON.stringify({ spec: { ...spec, channels } }),
    });
    expect(save.ok).toBe(true);
    expect(((save.data.spec as Record<string, unknown>).channels as Record<string, Record<string, unknown>>).chat.exposure).toBe("host");
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

  it("index.html includes all page containers", async () => {
    const r = await api("/");
    const text = await r.text();
    expect(text).toContain('id="page-extensions"');
    expect(text).toContain('id="page-channels"');
    expect(text).toContain('id="page-automations"');
    expect(text).toContain('id="page-system"');
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
});

// ── Providers ──────────────────────────────────────────

describe("providers", () => {
  it("GET /admin/providers requires auth", async () => {
    const r = await apiJson("/admin/providers");
    expect(r.status).toBe(401);
  });

  it("GET /admin/providers returns empty list initially", async () => {
    const r = await authed("/admin/providers");
    expect(r.ok).toBe(true);
    expect(r.data.providers).toEqual([]);
    expect(r.data.assignments).toEqual({});
  });

  it("POST /admin/providers creates a provider", async () => {
    const r = await authed("/admin/providers", {
      method: "POST",
      body: JSON.stringify({ name: "TestProvider", url: "http://localhost:11434/v1", apiKey: "test-key" }),
    });
    expect(r.status).toBe(201);
    expect(r.data.ok).toBe(true);
    const provider = r.data.provider as Record<string, unknown>;
    expect(provider.name).toBe("TestProvider");
    expect(provider.apiKey).toBe("••••••"); // masked
  });

  it("POST /admin/providers validates name required", async () => {
    const r = await authed("/admin/providers", {
      method: "POST",
      body: JSON.stringify({ url: "http://test" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("name is required");
  });

  it("GET /admin/providers lists providers with masked keys", async () => {
    const r = await authed("/admin/providers");
    expect(r.ok).toBe(true);
    const providers = r.data.providers as Array<Record<string, unknown>>;
    expect(providers.length).toBeGreaterThan(0);
    expect(providers[0].apiKey).toBe("••••••");
  });

  it("POST /admin/providers/update updates a provider", async () => {
    const list = await authed("/admin/providers");
    const providers = list.data.providers as Array<{ id: string }>;
    const r = await authed("/admin/providers/update", {
      method: "POST",
      body: JSON.stringify({ id: providers[0].id, name: "Updated" }),
    });
    expect(r.ok).toBe(true);
    expect((r.data.provider as Record<string, unknown>).name).toBe("Updated");
  });

  it("POST /admin/providers/update returns 404 for missing", async () => {
    const r = await authed("/admin/providers/update", {
      method: "POST",
      body: JSON.stringify({ id: "nonexistent", name: "x" }),
    });
    expect(r.status).toBe(404);
  });

  it("POST /admin/providers/assign validates inputs", async () => {
    const r = await authed("/admin/providers/assign", {
      method: "POST",
      body: JSON.stringify({ role: "invalid" }),
    });
    expect(r.status).toBe(400);
  });

  it("POST /admin/providers/assign assigns a model", async () => {
    const list = await authed("/admin/providers");
    const providers = list.data.providers as Array<{ id: string }>;
    const r = await authed("/admin/providers/assign", {
      method: "POST",
      body: JSON.stringify({ role: "small", providerId: providers[0].id, modelId: "test-model" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.assignments).toHaveProperty("small");
  });

  it("POST /admin/providers/models returns 404 for missing provider", async () => {
    const r = await authed("/admin/providers/models", {
      method: "POST",
      body: JSON.stringify({ providerId: "nonexistent" }),
    });
    expect(r.status).toBe(404);
  });

  it("POST /admin/providers/delete removes a provider", async () => {
    const list = await authed("/admin/providers");
    const providers = list.data.providers as Array<{ id: string }>;
    const r = await authed("/admin/providers/delete", {
      method: "POST",
      body: JSON.stringify({ id: providers[0].id }),
    });
    expect(r.ok).toBe(true);
    const after = await authed("/admin/providers");
    expect((after.data.providers as Array<unknown>).length).toBe(0);
  });

  it("POST /admin/providers/delete returns 404 for missing", async () => {
    const r = await authed("/admin/providers/delete", {
      method: "POST",
      body: JSON.stringify({ id: "nonexistent" }),
    });
    expect(r.status).toBe(404);
  });
});
