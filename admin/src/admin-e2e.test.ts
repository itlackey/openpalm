/**
 * End-to-end tests for the admin server HTTP API.
 *
 * These tests spin up the admin server against a temporary file system
 * and verify every page/endpoint the admin UI relies on.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, copyFileSync, existsSync, cpSync } from "node:fs";
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
  const caddyDir = join(tmpDir, "caddy");
  const channelEnvDir = join(tmpDir, "channel-env");
  const cronDir = join(tmpDir, "cron");

  for (const d of [dataDir, uiDir, configDir, caddyDir, channelEnvDir, cronDir]) mkdirSync(d, { recursive: true });

  // Copy SvelteKit build output if it exists, otherwise create minimal fallback
  const buildDir = join(REPO_ROOT, "admin/ui/build");
  if (existsSync(buildDir)) {
    cpSync(buildDir, uiDir, { recursive: true });
  } else {
    writeFileSync(join(uiDir, "index.html"), '<!doctype html><html lang="en"><head><title>OpenPalm Admin</title><link rel="stylesheet" href="/_app/immutable/assets/app.css"></head><body><div id="app"></div><script type="module" src="/_app/immutable/entry/start.js"></script></body></html>', "utf8");
    // Minimal valid PNG (1x1 transparent pixel)
    writeFileSync(join(uiDir, "logo.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQABNjN9GQAAAABJRU5ErkJggg==", "base64"));
  }

  // Copy config files
  copyFileSync(join(REPO_ROOT, "opencode/extensions/opencode.jsonc"), opencodeConfigPath);
  copyFileSync(join(REPO_ROOT, "assets/state/caddy/Caddyfile"), join(caddyDir, "Caddyfile"));

  // Create required env/secrets files
  writeFileSync(join(tmpDir, ".env"), "", "utf8");
  writeFileSync(join(tmpDir, "secrets.env"), "", "utf8");

  // Create channel env files
  for (const ch of ["channel-chat", "channel-discord", "channel-voice", "channel-telegram"]) {
    writeFileSync(join(channelEnvDir, `${ch}.env`), "", "utf8");
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
      DATA_DIR: dataDir,
      UI_DIR: uiDir,
      OPENCODE_CONFIG_PATH: opencodeConfigPath,
      CADDYFILE_PATH: join(caddyDir, "Caddyfile"),
      CHANNEL_ENV_DIR: channelEnvDir,
      CRON_DIR: cronDir,
      RUNTIME_ENV_PATH: join(tmpDir, ".env"),
      SECRETS_ENV_PATH: join(tmpDir, "secrets.env"),
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

  it("GET / redirects to /admin/", async () => {
    const r = await api("/", { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/admin/");
  });

  it("GET /admin/ serves SPA index.html", async () => {
    const r = await api("/admin/");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("<!doctype html>");
    expect(text).toContain("OpenPalm Admin");
  });

  it("GET /admin/extensions serves SPA fallback", async () => {
    const r = await api("/admin/extensions");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("<!doctype html>");
  });

  it("GET /logo.png serves the logo", async () => {
    const r = await api("/logo.png");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
  });

  it("GET /index.html serves SPA fallback", async () => {
    const r = await api("/index.html");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("<!doctype html>");
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

  it("POST /admin/setup/access-scope sets scope", async () => {
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

  it("after completion, write endpoints work with auth", async () => {
    const r = await authed("/admin/setup/access-scope", {
      method: "POST",
      body: JSON.stringify({ scope: "lan" }),
    });
    expect(r.ok).toBe(true);
  });
});

// ── Gallery ─────────────────────────────────────────────

describe("gallery", () => {
  it("GET /admin/gallery/search returns items without auth", async () => {
    const r = await apiJson("/admin/gallery/search?q=");
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data.items)).toBe(true);
    expect((r.data.total as number) > 0).toBe(true);
  });

  it("gallery search filters by query", async () => {
    const r = await apiJson("/admin/gallery/search?q=policy");
    const items = r.data.items as Array<{ id: string }>;
    expect(items.some((i) => i.id === "plugin-policy-telemetry")).toBe(true);
  });

  it("gallery search filters by category", async () => {
    const r = await apiJson("/admin/gallery/search?q=&category=channel");
    const items = r.data.items as Array<{ category: string }>;
    expect(items.every((i) => i.category === "channel")).toBe(true);
    expect(items.length).toBeGreaterThan(0);
  });

  it("GET /admin/gallery/categories lists categories", async () => {
    const r = await apiJson("/admin/gallery/categories");
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data.categories)).toBe(true);
  });

  it("GET /admin/gallery/item/:id returns item detail", async () => {
    const r = await apiJson("/admin/gallery/item/plugin-policy-telemetry");
    expect(r.ok).toBe(true);
    expect((r.data.item as Record<string, unknown>).name).toBe("Policy & Telemetry");
    expect(r.data).toHaveProperty("riskBadge");
  });

  it("GET /admin/gallery/item/:id returns 404 for missing", async () => {
    const r = await apiJson("/admin/gallery/item/nonexistent");
    expect(r.status).toBe(404);
  });
});

// ── Auth-protected endpoints ─────────────────────────────

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
    expect(names.opencodeCore.label).toBe("AI Assistant");
    expect(names.openmemory.label).toBe("Memory");
    const fields = r.data.channelFields as Record<string, Array<{ key: string; label: string }>>;
    expect(fields["channel-discord"].length).toBe(2);
    expect(fields["channel-discord"][0].label).toBe("Bot Token");
  });
});

// ── UI Content Verification ─────────────────────────────

describe("UI content", () => {
  it("SPA index.html includes SvelteKit assets", async () => {
    const r = await api("/admin/");
    const text = await r.text();
    expect(text).toContain("<!doctype html>");
    expect(text).toContain("OpenPalm Admin");
    // SvelteKit bundles are referenced in the HTML
    expect(text).toContain("_app/");
  });

  it("SPA serves consistent content for client-only routes", async () => {
    // SPA routes that DON'T conflict with any API GET endpoints.
    // Conflicting paths to avoid: /admin/channels, /admin/automations, /admin/providers,
    // /admin/config, /admin/installed (all require auth and return 401).
    // These paths have no matching API route, so the server falls through to SPA fallback:
    const routes = ["/admin/system", "/admin/extensions", "/admin/setup", "/admin/containers"];
    for (const route of routes) {
      const r = await api(route);
      expect(r.status).toBe(200);
      const text = await r.text();
      expect(text).toContain("<!doctype html>");
    }
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

// ── Setup Wizard Complete Flow ──────────────────────────

describe("setup wizard complete flow", () => {
  it("POST /admin/setup/access-scope with valid scope 'host' (authed)", async () => {
    const r = await authed("/admin/setup/access-scope", {
      method: "POST",
      body: JSON.stringify({ scope: "host" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
  });

  it("POST /admin/setup/access-scope with valid scope 'lan' (authed)", async () => {
    const r = await authed("/admin/setup/access-scope", {
      method: "POST",
      body: JSON.stringify({ scope: "lan" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
  });

  it("POST /admin/setup/access-scope rejects invalid scope", async () => {
    const r = await authed("/admin/setup/access-scope", {
      method: "POST",
      body: JSON.stringify({ scope: "internet" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("invalid scope");
  });

  it("POST /admin/setup/channels with channel selection (authed)", async () => {
    const r = await authed("/admin/setup/channels", {
      method: "POST",
      body: JSON.stringify({ channels: ["channel-chat", "channel-discord"] }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
  });

  it("POST /admin/setup/channels with empty selection (authed)", async () => {
    const r = await authed("/admin/setup/channels", {
      method: "POST",
      body: JSON.stringify({ channels: [] }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
  });

  it("POST /admin/setup/service-instances with valid URLs (authed)", async () => {
    const r = await authed("/admin/setup/service-instances", {
      method: "POST",
      body: JSON.stringify({
        openmemory: "http://openmemory:8765",
        psql: "postgresql://user:pass@db:5432/openpalm",
        qdrant: "http://qdrant:6333",
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
  });

  it("POST /admin/setup/service-instances configures small model fields (authed)", async () => {
    const r = await authed("/admin/setup/service-instances", {
      method: "POST",
      body: JSON.stringify({
        openmemory: "",
        psql: "",
        qdrant: "",
        smallModelEndpoint: "http://ollama:11434/v1",
        smallModelId: "llama3.2",
        smallModelApiKey: "test-small-key",
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    const smallModel = r.data.smallModelProvider as Record<string, unknown>;
    expect(smallModel.modelId).toBe("llama3.2");
    expect(smallModel.endpoint).toBe("http://ollama:11434/v1");
    expect(smallModel.apiKeyConfigured).toBe(true);
  });

  it("full wizard step completion flow (all steps marked, then complete)", async () => {
    const steps = ["welcome", "accessScope", "serviceInstances", "healthCheck", "security", "channels", "extensions"];
    for (const step of steps) {
      const r = await authed("/admin/setup/step", {
        method: "POST",
        body: JSON.stringify({ step }),
      });
      expect(r.ok).toBe(true);
    }
    // Verify status shows completed (it was already completed earlier, this re-confirms)
    const status = await authed("/admin/setup/status");
    expect(status.ok).toBe(true);
    expect(status.data.completed).toBe(true);
  });
});

// ── Gallery Extended Tests ──────────────────────────────

describe("gallery extended", () => {
  it("GET /admin/gallery/categories returns a non-empty categories array", async () => {
    const r = await apiJson("/admin/gallery/categories");
    expect(r.ok).toBe(true);
    const categories = r.data.categories as Array<{ category: string; count: number }>;
    expect(Array.isArray(categories)).toBe(true);
    expect(categories.length).toBeGreaterThan(0);
    // Should include standard categories
    const categoryNames = categories.map((c) => c.category);
    expect(categoryNames).toContain("plugin");
    expect(categoryNames).toContain("channel");
    // Each category has a count
    for (const cat of categories) {
      expect(typeof cat.category).toBe("string");
      expect(typeof cat.count).toBe("number");
      expect(cat.count).toBeGreaterThan(0);
    }
  });

  it("GET /admin/gallery/search with category filter returns matching items", async () => {
    const r = await apiJson("/admin/gallery/search?q=&category=plugin");
    expect(r.ok).toBe(true);
    const items = r.data.items as Array<{ category: string }>;
    expect(items.every((i) => i.category === "plugin")).toBe(true);
  });

  it("GET /admin/gallery/item/:id returns detail for valid item", async () => {
    const r = await apiJson("/admin/gallery/item/plugin-policy-telemetry");
    expect(r.ok).toBe(true);
    const item = r.data.item as Record<string, unknown>;
    expect(item).toHaveProperty("id");
    expect(item).toHaveProperty("name");
    expect(item).toHaveProperty("risk");
    expect(r.data).toHaveProperty("riskBadge");
  });

  it("GET /admin/gallery/item/:id returns 404 for invalid item", async () => {
    const r = await apiJson("/admin/gallery/item/does-not-exist-at-all");
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("item not found");
  });

  it("POST /admin/gallery/install with invalid galleryId returns 404", async () => {
    const r = await authed("/admin/gallery/install", {
      method: "POST",
      body: JSON.stringify({ galleryId: "nonexistent-gallery-id-xyz" }),
    });
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("gallery item not found");
  });

  it("POST /admin/gallery/uninstall requires auth", async () => {
    const r = await apiJson("/admin/gallery/uninstall", {
      method: "POST",
      body: JSON.stringify({ galleryId: "plugin-policy-telemetry" }),
    });
    expect(r.status).toBe(401);
  });

  it("POST /admin/gallery/uninstall with missing params returns 400", async () => {
    const r = await authed("/admin/gallery/uninstall", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("galleryId or pluginId required");
  });

  it("POST /admin/gallery/community/refresh requires auth", async () => {
    const r = await apiJson("/admin/gallery/community/refresh", {
      method: "POST",
    });
    expect(r.status).toBe(401);
  });

  it("POST /admin/gallery/install with no galleryId or pluginId returns 400", async () => {
    const r = await authed("/admin/gallery/install", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("galleryId or pluginId required");
  });

  it("POST /admin/gallery/install requires auth", async () => {
    const r = await apiJson("/admin/gallery/install", {
      method: "POST",
      body: JSON.stringify({ galleryId: "plugin-policy-telemetry" }),
    });
    expect(r.status).toBe(401);
  });
});

// ── Channel Management Extended Tests ───────────────────

describe("channel management extended", () => {
  it("GET /admin/channels/config with valid service returns config", async () => {
    const r = await authed("/admin/channels/config?service=channel-discord");
    expect(r.ok).toBe(true);
    expect(r.data.service).toBe("channel-discord");
    const config = r.data.config as Record<string, string>;
    expect(config).toHaveProperty("DISCORD_BOT_TOKEN");
    expect(config).toHaveProperty("DISCORD_PUBLIC_KEY");
  });

  it("GET /admin/channels/config with invalid service returns 400", async () => {
    const r = await authed("/admin/channels/config?service=invalid-service");
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("invalid service");
  });

  it("POST /admin/channels/config with valid config saves it", async () => {
    const r = await authed("/admin/channels/config", {
      method: "POST",
      body: JSON.stringify({
        service: "channel-discord",
        config: { DISCORD_BOT_TOKEN: "test-token-123", DISCORD_PUBLIC_KEY: "test-key-456" },
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.service).toBe("channel-discord");

    // Verify the config was persisted
    const read = await authed("/admin/channels/config?service=channel-discord");
    const config = read.data.config as Record<string, string>;
    expect(config.DISCORD_BOT_TOKEN).toBe("test-token-123");
    expect(config.DISCORD_PUBLIC_KEY).toBe("test-key-456");
  });

  it("POST /admin/channels/config with restart=false does not error", async () => {
    const r = await authed("/admin/channels/config", {
      method: "POST",
      body: JSON.stringify({
        service: "channel-telegram",
        config: { TELEGRAM_BOT_TOKEN: "tg-token", TELEGRAM_WEBHOOK_SECRET: "tg-secret" },
        restart: false,
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
  });

  it("POST /admin/channels/config with invalid service returns 400", async () => {
    const r = await authed("/admin/channels/config", {
      method: "POST",
      body: JSON.stringify({ service: "invalid-svc", config: {} }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("invalid service");
  });

  it("GET /admin/channels/config requires auth", async () => {
    const r = await apiJson("/admin/channels/config?service=channel-chat");
    expect(r.status).toBe(401);
  });

  it("POST /admin/channels/config requires auth", async () => {
    const r = await apiJson("/admin/channels/config", {
      method: "POST",
      body: JSON.stringify({ service: "channel-chat", config: {} }),
    });
    expect(r.status).toBe(401);
  });

  it("POST /admin/channels/access sets channel access mode", async () => {
    const r = await authed("/admin/channels/access", {
      method: "POST",
      body: JSON.stringify({ channel: "chat", access: "public" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.channel).toBe("chat");
    expect(r.data.access).toBe("public");
  });

  it("POST /admin/channels/access rejects invalid channel", async () => {
    const r = await authed("/admin/channels/access", {
      method: "POST",
      body: JSON.stringify({ channel: "invalid", access: "lan" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("invalid channel");
  });

  it("POST /admin/channels/access rejects invalid access", async () => {
    const r = await authed("/admin/channels/access", {
      method: "POST",
      body: JSON.stringify({ channel: "chat", access: "invalid" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("invalid access");
  });

  it("GET /admin/channels returns channels with access mode and config", async () => {
    const r = await authed("/admin/channels");
    expect(r.ok).toBe(true);
    const channels = r.data.channels as Array<{ service: string; label: string; access: string; config: Record<string, string>; fields: Array<{ key: string }> }>;
    expect(channels.length).toBe(4);
    const services = channels.map((c) => c.service);
    expect(services).toContain("channel-chat");
    expect(services).toContain("channel-discord");
    expect(services).toContain("channel-voice");
    expect(services).toContain("channel-telegram");
    // Each channel has a label
    for (const ch of channels) {
      expect(ch.label.length).toBeGreaterThan(0);
      expect(typeof ch.access).toBe("string");
    }
  });
});

// ── Automations Complete CRUD Flow ──────────────────────

describe("automations complete CRUD flow", () => {
  let createdId: string;

  it("full lifecycle: create → list → update → trigger → delete", async () => {
    // Create
    const createResp = await authed("/admin/automations", {
      method: "POST",
      body: JSON.stringify({ name: "Test Cron Job", schedule: "0 9 * * 1", prompt: "Weekly status report" }),
    });
    expect(createResp.status).toBe(201);
    expect(createResp.data.ok).toBe(true);
    const automation = createResp.data.automation as Record<string, unknown>;
    createdId = automation.id as string;
    expect(automation.name).toBe("Test Cron Job");
    expect(automation.schedule).toBe("0 9 * * 1");
    expect(automation.prompt).toBe("Weekly status report");
    expect(automation.status).toBe("enabled");
    expect(automation).toHaveProperty("createdAt");

    // List
    const listResp = await authed("/admin/automations");
    expect(listResp.ok).toBe(true);
    const automations = listResp.data.automations as Array<{ id: string; name: string }>;
    expect(automations.some((a) => a.id === createdId)).toBe(true);

    // Update
    const updateResp = await authed("/admin/automations/update", {
      method: "POST",
      body: JSON.stringify({ id: createdId, name: "Updated Cron Job", schedule: "30 8 * * *" }),
    });
    expect(updateResp.ok).toBe(true);
    const updated = updateResp.data.automation as Record<string, unknown>;
    expect(updated.name).toBe("Updated Cron Job");
    expect(updated.schedule).toBe("30 8 * * *");

    // Trigger
    const triggerResp = await authed("/admin/automations/trigger", {
      method: "POST",
      body: JSON.stringify({ id: createdId }),
    });
    expect(triggerResp.ok).toBe(true);
    expect(triggerResp.data.triggered).toBe(createdId);

    // Delete
    const deleteResp = await authed("/admin/automations/delete", {
      method: "POST",
      body: JSON.stringify({ id: createdId }),
    });
    expect(deleteResp.ok).toBe(true);
    expect(deleteResp.data.deleted).toBe(createdId);

    // Verify deletion
    const listAfter = await authed("/admin/automations");
    const remaining = listAfter.data.automations as Array<{ id: string }>;
    expect(remaining.some((a) => a.id === createdId)).toBe(false);
  });

  it("creating automation with invalid cron expression returns 400", async () => {
    const r = await authed("/admin/automations", {
      method: "POST",
      body: JSON.stringify({ name: "Bad Cron", schedule: "not a cron", prompt: "test" }),
    });
    expect(r.status).toBe(400);
    expect((r.data.error as string)).toContain("invalid cron expression");
  });

  it("creating automation with missing fields returns 400", async () => {
    const r = await authed("/admin/automations", {
      method: "POST",
      body: JSON.stringify({ name: "No Schedule" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("name, schedule, and prompt are required");
  });

  it("updating automation with invalid cron returns 400", async () => {
    // Create a valid one first
    const create = await authed("/admin/automations", {
      method: "POST",
      body: JSON.stringify({ name: "For Update Test", schedule: "0 0 * * *", prompt: "test" }),
    });
    const id = (create.data.automation as Record<string, unknown>).id as string;

    const r = await authed("/admin/automations/update", {
      method: "POST",
      body: JSON.stringify({ id, schedule: "bad cron here" }),
    });
    expect(r.status).toBe(400);
    expect((r.data.error as string)).toContain("invalid cron expression");

    // Clean up
    await authed("/admin/automations/delete", { method: "POST", body: JSON.stringify({ id }) });
  });

  it("updating non-existent automation returns 404", async () => {
    const r = await authed("/admin/automations/update", {
      method: "POST",
      body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000000", name: "ghost" }),
    });
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("automation not found");
  });

  it("deleting non-existent automation returns 404", async () => {
    const r = await authed("/admin/automations/delete", {
      method: "POST",
      body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("automation not found");
  });

  it("triggering non-existent automation returns 404", async () => {
    const r = await authed("/admin/automations/trigger", {
      method: "POST",
      body: JSON.stringify({ id: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("automation not found");
  });

  it("POST /admin/automations requires auth", async () => {
    const r = await apiJson("/admin/automations", {
      method: "POST",
      body: JSON.stringify({ name: "x", schedule: "0 * * * *", prompt: "y" }),
    });
    expect(r.status).toBe(401);
  });

  it("POST /admin/automations/update requires auth", async () => {
    const r = await apiJson("/admin/automations/update", {
      method: "POST",
      body: JSON.stringify({ id: "x" }),
    });
    expect(r.status).toBe(401);
  });

  it("POST /admin/automations/delete requires auth", async () => {
    const r = await apiJson("/admin/automations/delete", {
      method: "POST",
      body: JSON.stringify({ id: "x" }),
    });
    expect(r.status).toBe(401);
  });

  it("POST /admin/automations/trigger requires auth", async () => {
    const r = await apiJson("/admin/automations/trigger", {
      method: "POST",
      body: JSON.stringify({ id: "x" }),
    });
    expect(r.status).toBe(401);
  });
});

// ── Providers Complete CRUD Flow ────────────────────────

describe("providers complete CRUD flow", () => {
  let providerId: string;

  it("full lifecycle: create → list → update → assign → delete", async () => {
    // Create
    const createResp = await authed("/admin/providers", {
      method: "POST",
      body: JSON.stringify({ name: "CRUDProvider", url: "http://localhost:11434/v1", apiKey: "secret-key-123" }),
    });
    expect(createResp.status).toBe(201);
    const provider = createResp.data.provider as Record<string, unknown>;
    providerId = provider.id as string;
    expect(provider.name).toBe("CRUDProvider");
    expect(provider.apiKey).toBe("••••••");

    // List
    const listResp = await authed("/admin/providers");
    expect(listResp.ok).toBe(true);
    const providers = listResp.data.providers as Array<{ id: string }>;
    expect(providers.some((p) => p.id === providerId)).toBe(true);

    // Update
    const updateResp = await authed("/admin/providers/update", {
      method: "POST",
      body: JSON.stringify({ id: providerId, name: "UpdatedCRUD", url: "http://new-host:11434/v1" }),
    });
    expect(updateResp.ok).toBe(true);
    expect((updateResp.data.provider as Record<string, unknown>).name).toBe("UpdatedCRUD");

    // Assign
    const assignResp = await authed("/admin/providers/assign", {
      method: "POST",
      body: JSON.stringify({ role: "small", providerId, modelId: "llama3.2:latest" }),
    });
    expect(assignResp.ok).toBe(true);
    const assignments = assignResp.data.assignments as Record<string, { providerId: string; modelId: string }>;
    expect(assignments.small.providerId).toBe(providerId);
    expect(assignments.small.modelId).toBe("llama3.2:latest");

    // Delete
    const deleteResp = await authed("/admin/providers/delete", {
      method: "POST",
      body: JSON.stringify({ id: providerId }),
    });
    expect(deleteResp.ok).toBe(true);

    // Verify deletion
    const listAfter = await authed("/admin/providers");
    const remaining = listAfter.data.providers as Array<{ id: string }>;
    expect(remaining.some((p) => p.id === providerId)).toBe(false);
  });

  it("updating non-existent provider returns 404", async () => {
    const r = await authed("/admin/providers/update", {
      method: "POST",
      body: JSON.stringify({ id: "nonexistent-provider-id", name: "ghost" }),
    });
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("provider not found");
  });

  it("deleting non-existent provider returns 404", async () => {
    const r = await authed("/admin/providers/delete", {
      method: "POST",
      body: JSON.stringify({ id: "nonexistent-provider-id" }),
    });
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("provider not found");
  });

  it("POST /admin/providers/models with non-existent provider returns 404", async () => {
    const r = await authed("/admin/providers/models", {
      method: "POST",
      body: JSON.stringify({ providerId: "nonexistent-provider-id" }),
    });
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("provider not found");
  });

  it("POST /admin/providers/assign with invalid role returns 400", async () => {
    const r = await authed("/admin/providers/assign", {
      method: "POST",
      body: JSON.stringify({ role: "invalid-role", providerId: "some-id", modelId: "some-model" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("role must be 'small' or 'openmemory'");
  });

  it("POST /admin/providers/assign with missing fields returns 400", async () => {
    const r = await authed("/admin/providers/assign", {
      method: "POST",
      body: JSON.stringify({ role: "small" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("role, providerId, and modelId are required");
  });

  it("POST /admin/providers/models with missing providerId returns 400", async () => {
    const r = await authed("/admin/providers/models", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("providerId is required");
  });

  it("POST /admin/providers requires auth", async () => {
    const r = await apiJson("/admin/providers", {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
    });
    expect(r.status).toBe(401);
  });

  it("POST /admin/providers/update requires auth", async () => {
    const r = await apiJson("/admin/providers/update", {
      method: "POST",
      body: JSON.stringify({ id: "x" }),
    });
    expect(r.status).toBe(401);
  });

  it("POST /admin/providers/delete requires auth", async () => {
    const r = await apiJson("/admin/providers/delete", {
      method: "POST",
      body: JSON.stringify({ id: "x" }),
    });
    expect(r.status).toBe(401);
  });
});

// ── Config Editor Extended Tests ────────────────────────

describe("config editor extended", () => {
  it("POST /admin/config with policy violation (permission: allow) returns 400", async () => {
    const r = await authed("/admin/config", {
      method: "POST",
      body: JSON.stringify({ config: JSON.stringify({ permission: { "Bash(*)": "allow" } }) }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("This change would weaken security protections and was blocked");
  });

  it("POST /admin/config with non-object JSON returns 400", async () => {
    // A valid JSON string that is not an object triggers the "syntax error" guard
    const r = await authed("/admin/config", {
      method: "POST",
      body: JSON.stringify({ config: '"just a string"' }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("The configuration file has a syntax error");
  });

  it("POST /admin/config with unparseable JSON returns 500", async () => {
    // Completely invalid JSON causes parseJsonc to throw, caught by server error handler
    const r = await authed("/admin/config", {
      method: "POST",
      body: JSON.stringify({ config: "{ not valid json !!!" }),
    });
    expect(r.status).toBe(500);
  });

  it("POST /admin/config creates a backup file on successful write", async () => {
    // Read existing config first
    const getCfg = await api("/admin/config", {
      headers: { "x-admin-token": "test-token-e2e" },
    });
    const currentConfig = await getCfg.text();

    // Write a valid config
    const r = await authed("/admin/config", {
      method: "POST",
      body: JSON.stringify({ config: currentConfig, restart: false }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    // Server returns the backup path
    expect(typeof r.data.backup).toBe("string");
    expect((r.data.backup as string)).toContain(".bak");
  });

  it("POST /admin/config with valid JSON succeeds", async () => {
    const validConfig = JSON.stringify({ "$schema": "opencode.schema.json" });
    const r = await authed("/admin/config", {
      method: "POST",
      body: JSON.stringify({ config: validConfig, restart: false }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
  });

  it("POST /admin/config with permission deny is allowed", async () => {
    const config = JSON.stringify({ permission: { "Bash(*)": "deny" } });
    const r = await authed("/admin/config", {
      method: "POST",
      body: JSON.stringify({ config, restart: false }),
    });
    expect(r.ok).toBe(true);
  });

  it("POST /admin/config with permission ask is allowed", async () => {
    const config = JSON.stringify({ permission: { "Bash(*)": "ask" } });
    const r = await authed("/admin/config", {
      method: "POST",
      body: JSON.stringify({ config, restart: false }),
    });
    expect(r.ok).toBe(true);
  });

  it("POST /admin/config requires auth", async () => {
    const r = await apiJson("/admin/config", {
      method: "POST",
      body: JSON.stringify({ config: "{}" }),
    });
    expect(r.status).toBe(401);
  });
});

// ── Container Management Tests ──────────────────────────

describe("container management", () => {
  it("POST /admin/containers/up with valid service returns 502 without controller", async () => {
    const r = await authed("/admin/containers/up", {
      method: "POST",
      body: JSON.stringify({ service: "opencode-core" }),
    });
    expect(r.status).toBe(502);
    expect(r.data.ok).toBe(false);
    expect(r.data.error).toBe("controller not configured");
  });

  it("POST /admin/containers/up with invalid service name returns 400", async () => {
    const r = await authed("/admin/containers/up", {
      method: "POST",
      body: JSON.stringify({ service: "nonexistent-service" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("unknown service name");
  });

  it("POST /admin/containers/down with valid service returns 502 without controller", async () => {
    const r = await authed("/admin/containers/down", {
      method: "POST",
      body: JSON.stringify({ service: "channel-chat" }),
    });
    expect(r.status).toBe(502);
    expect(r.data.ok).toBe(false);
    expect(r.data.error).toBe("controller not configured");
  });

  it("POST /admin/containers/down with invalid service name returns 400", async () => {
    const r = await authed("/admin/containers/down", {
      method: "POST",
      body: JSON.stringify({ service: "bad-service" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("unknown service name");
  });

  it("POST /admin/containers/restart with valid service returns 502 without controller", async () => {
    const r = await authed("/admin/containers/restart", {
      method: "POST",
      body: JSON.stringify({ service: "gateway" }),
    });
    expect(r.status).toBe(502);
    expect(r.data.ok).toBe(false);
    expect(r.data.error).toBe("controller not configured");
  });

  it("POST /admin/containers/restart with invalid service name returns 400", async () => {
    const r = await authed("/admin/containers/restart", {
      method: "POST",
      body: JSON.stringify({ service: "totally-not-a-service" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("unknown service name");
  });

  it("POST /admin/containers/up with empty service returns 400", async () => {
    const r = await authed("/admin/containers/up", {
      method: "POST",
      body: JSON.stringify({ service: "" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("unknown service name");
  });

  it("GET /admin/containers/list requires auth", async () => {
    const r = await apiJson("/admin/containers/list");
    expect(r.status).toBe(401);
  });

  it("GET /admin/containers/list returns 503 without controller", async () => {
    const r = await authed("/admin/containers/list");
    expect(r.status).toBe(503);
    expect(r.data.error).toBe("controller not configured");
  });

  it("POST /admin/containers/up requires auth", async () => {
    const r = await apiJson("/admin/containers/up", {
      method: "POST",
      body: JSON.stringify({ service: "gateway" }),
    });
    expect(r.status).toBe(401);
  });

  it("POST /admin/containers/down requires auth", async () => {
    const r = await apiJson("/admin/containers/down", {
      method: "POST",
      body: JSON.stringify({ service: "gateway" }),
    });
    expect(r.status).toBe(401);
  });

  it("POST /admin/containers/restart requires auth", async () => {
    const r = await apiJson("/admin/containers/restart", {
      method: "POST",
      body: JSON.stringify({ service: "gateway" }),
    });
    expect(r.status).toBe(401);
  });
});

// ── Auth & Security Tests ───────────────────────────────

describe("auth and security", () => {
  const protectedGetEndpoints = [
    "/admin/installed",
    "/admin/channels",
    "/admin/automations",
    "/admin/config",
    "/admin/providers",
    "/admin/containers/list",
    "/admin/setup/status",
  ];

  for (const endpoint of protectedGetEndpoints) {
    it(`GET ${endpoint} rejects unauthenticated requests`, async () => {
      const r = await api(endpoint);
      expect(r.status).toBe(401);
    });
  }

  const protectedPostEndpoints = [
    { path: "/admin/gallery/install", body: { galleryId: "x" } },
    { path: "/admin/gallery/uninstall", body: { galleryId: "x" } },
    { path: "/admin/gallery/community/refresh", body: {} },
    { path: "/admin/containers/up", body: { service: "gateway" } },
    { path: "/admin/containers/down", body: { service: "gateway" } },
    { path: "/admin/containers/restart", body: { service: "gateway" } },
    { path: "/admin/automations", body: { name: "x", schedule: "0 * * * *", prompt: "y" } },
    { path: "/admin/automations/update", body: { id: "x" } },
    { path: "/admin/automations/delete", body: { id: "x" } },
    { path: "/admin/automations/trigger", body: { id: "x" } },
    { path: "/admin/providers", body: { name: "x" } },
    { path: "/admin/providers/update", body: { id: "x" } },
    { path: "/admin/providers/delete", body: { id: "x" } },
    { path: "/admin/providers/models", body: { providerId: "x" } },
    { path: "/admin/providers/assign", body: { role: "small", providerId: "x", modelId: "y" } },
    { path: "/admin/config", body: { config: "{}" } },
  ];

  for (const { path, body } of protectedPostEndpoints) {
    it(`POST ${path} rejects unauthenticated requests`, async () => {
      const r = await apiJson(path, {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(401);
    });
  }

  it("CORS headers are present on responses", async () => {
    const r = await api("/health");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-allow-headers")).toContain("x-admin-token");
    expect(r.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("OPTIONS returns 204 with CORS headers", async () => {
    const r = await api("/admin/config", { method: "OPTIONS" });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(r.headers.get("access-control-allow-headers")).toContain("x-admin-token");
    expect(r.headers.get("access-control-allow-headers")).toContain("content-type");
    expect(r.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("wrong token is rejected", async () => {
    const r = await apiJson("/admin/installed", {
      headers: { "x-admin-token": "wrong-token" } as Record<string, string>,
    });
    expect(r.status).toBe(401);
  });
});

// ── Meta Endpoint Tests ─────────────────────────────────

describe("meta endpoint extended", () => {
  it("GET /admin/meta returns serviceNames and channelFields", async () => {
    const r = await apiJson("/admin/meta");
    expect(r.ok).toBe(true);
    expect(r.data).toHaveProperty("serviceNames");
    expect(r.data).toHaveProperty("channelFields");
  });

  it("meta response includes all expected core services", async () => {
    const r = await apiJson("/admin/meta");
    const names = r.data.serviceNames as Record<string, { label: string; description: string }>;
    const expectedServices = ["gateway", "controller", "opencodeCore", "opencode-core", "openmemory", "openmemory-ui", "admin", "caddy"];
    for (const svc of expectedServices) {
      expect(names).toHaveProperty(svc);
      expect(names[svc].label.length).toBeGreaterThan(0);
      expect(names[svc].description.length).toBeGreaterThan(0);
    }
  });

  it("meta response includes all channel services", async () => {
    const r = await apiJson("/admin/meta");
    const names = r.data.serviceNames as Record<string, { label: string }>;
    const channelServices = ["channel-chat", "channel-discord", "channel-voice", "channel-telegram"];
    for (const svc of channelServices) {
      expect(names).toHaveProperty(svc);
      expect(names[svc].label.length).toBeGreaterThan(0);
    }
  });

  it("meta channelFields includes all channel services with correct structure", async () => {
    const r = await apiJson("/admin/meta");
    const fields = r.data.channelFields as Record<string, Array<{ key: string; label: string; type: string; required: boolean; helpText: string }>>;
    expect(fields).toHaveProperty("channel-chat");
    expect(fields).toHaveProperty("channel-discord");
    expect(fields).toHaveProperty("channel-voice");
    expect(fields).toHaveProperty("channel-telegram");

    // channel-chat has 1 field
    expect(fields["channel-chat"].length).toBe(1);
    expect(fields["channel-chat"][0].key).toBe("CHAT_INBOUND_TOKEN");

    // channel-discord has 2 fields
    expect(fields["channel-discord"].length).toBe(2);
    expect(fields["channel-discord"][0].key).toBe("DISCORD_BOT_TOKEN");
    expect(fields["channel-discord"][1].key).toBe("DISCORD_PUBLIC_KEY");

    // channel-voice is empty
    expect(fields["channel-voice"].length).toBe(0);

    // channel-telegram has 2 fields
    expect(fields["channel-telegram"].length).toBe(2);
    expect(fields["channel-telegram"][0].key).toBe("TELEGRAM_BOT_TOKEN");
    expect(fields["channel-telegram"][1].key).toBe("TELEGRAM_WEBHOOK_SECRET");
  });

  it("meta channelFields entries have required field properties", async () => {
    const r = await apiJson("/admin/meta");
    const fields = r.data.channelFields as Record<string, Array<Record<string, unknown>>>;
    for (const [, fieldList] of Object.entries(fields)) {
      for (const field of fieldList) {
        expect(field).toHaveProperty("key");
        expect(field).toHaveProperty("label");
        expect(field).toHaveProperty("type");
        expect(field).toHaveProperty("required");
        expect(field).toHaveProperty("helpText");
        expect(typeof field.key).toBe("string");
        expect(typeof field.label).toBe("string");
        expect(["text", "password"]).toContain(field.type as string);
      }
    }
  });
});

// ── Gallery: npm Search Tests ───────────────────────────
// Docs: GET /admin/gallery/npm-search?q=

describe("gallery npm search", () => {
  it("GET /admin/gallery/npm-search without query returns 400", async () => {
    const r = await apiJson("/admin/gallery/npm-search?q=");
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("query required");
  });

  it("GET /admin/gallery/npm-search with query returns results array", async () => {
    // npm search makes an external call; in test env this may return empty results
    // but the endpoint should still respond with the correct shape
    const r = await apiJson("/admin/gallery/npm-search?q=opencode");
    // If external fetch fails, still expect a 200 with an empty array
    if (r.ok) {
      expect(Array.isArray(r.data.results)).toBe(true);
    } else {
      // network failure in test env is acceptable - verify it doesn't crash
      expect([200, 500]).toContain(r.status);
    }
  });
});

// ── Gallery: Community Registry Tests ───────────────────
// Docs: GET /admin/gallery/community?q=&category=

describe("gallery community registry", () => {
  it("GET /admin/gallery/community returns items array with correct shape", async () => {
    const r = await apiJson("/admin/gallery/community?q=");
    // Community registry fetches from GitHub; may return empty in test env
    if (r.ok) {
      expect(r.data).toHaveProperty("items");
      expect(r.data).toHaveProperty("total");
      expect(r.data).toHaveProperty("source");
      expect(r.data.source).toBe("community-registry");
      expect(Array.isArray(r.data.items)).toBe(true);
      expect(typeof r.data.total).toBe("number");
    }
  });

  it("GET /admin/gallery/community with category filter", async () => {
    const r = await apiJson("/admin/gallery/community?q=&category=plugin");
    if (r.ok) {
      expect(Array.isArray(r.data.items)).toBe(true);
      expect(r.data.source).toBe("community-registry");
    }
  });

  it("POST /admin/gallery/community/refresh with auth returns refresh result", async () => {
    const r = await authed("/admin/gallery/community/refresh", { method: "POST" });
    if (r.ok) {
      expect(r.data.ok).toBe(true);
      expect(typeof r.data.total).toBe("number");
      expect(typeof r.data.refreshedAt).toBe("string");
    }
  });
});

// ── Gallery: Successful Install/Uninstall Flow ─────────
// Docs: POST /admin/gallery/install, POST /admin/gallery/uninstall

describe("gallery install and uninstall flow", () => {
  it("POST /admin/gallery/install with valid curated galleryId succeeds", async () => {
    const r = await authed("/admin/gallery/install", {
      method: "POST",
      body: JSON.stringify({ galleryId: "plugin-policy-telemetry" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.installed).toBe("plugin-policy-telemetry");
    expect(r.data.type).toBe("plugin");
  });

  it("after install, GET /admin/installed includes the installed extension", async () => {
    const r = await authed("/admin/installed");
    expect(r.ok).toBe(true);
    const plugins = r.data.plugins as string[];
    expect(Array.isArray(plugins)).toBe(true);
    // The plugin should now be in the installed list
    expect(plugins.length).toBeGreaterThan(0);
  });

  it("POST /admin/gallery/uninstall with valid galleryId succeeds", async () => {
    const r = await authed("/admin/gallery/uninstall", {
      method: "POST",
      body: JSON.stringify({ galleryId: "plugin-policy-telemetry" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
  });
});

// ── Health Check: Verify All Expected Services ─────────
// Docs: Health indicators for each core service + channel adapters

describe("health check service coverage", () => {
  it("GET /admin/setup/health-check returns all expected core services", async () => {
    const r = await apiJson("/admin/setup/health-check");
    expect(r.ok).toBe(true);
    const services = r.data.services as Record<string, { ok: boolean }>;
    // Docs specify: gateway, OpenCode Core, OpenMemory, admin, controller
    const expectedKeys = ["gateway", "controller", "opencodeCore", "openmemory", "admin"];
    for (const key of expectedKeys) {
      expect(services).toHaveProperty(key);
      expect(typeof services[key].ok).toBe("boolean");
    }
  });

  it("health-check admin service is always healthy (self-check)", async () => {
    const r = await apiJson("/admin/setup/health-check");
    const services = r.data.services as Record<string, { ok: boolean }>;
    expect(services.admin.ok).toBe(true);
  });
});

// ── Channel Config: All 4 Channels Verified ─────────────
// Docs: Each channel has specific config fields

describe("channel config for all platforms", () => {
  const channelConfigs: Array<{ service: string; expectedKeys: string[] }> = [
    { service: "channel-chat", expectedKeys: ["CHAT_INBOUND_TOKEN"] },
    { service: "channel-discord", expectedKeys: ["DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY"] },
    { service: "channel-voice", expectedKeys: [] },
    { service: "channel-telegram", expectedKeys: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"] },
  ];

  for (const { service, expectedKeys } of channelConfigs) {
    it(`GET /admin/channels/config?service=${service} returns config with expected keys`, async () => {
      const r = await authed(`/admin/channels/config?service=${service}`);
      expect(r.ok).toBe(true);
      expect(r.data.service).toBe(service);
      const config = r.data.config as Record<string, string>;
      for (const key of expectedKeys) {
        expect(config).toHaveProperty(key);
      }
    });
  }

  it("POST /admin/channels/config with chat channel and optional token", async () => {
    const r = await authed("/admin/channels/config", {
      method: "POST",
      body: JSON.stringify({
        service: "channel-chat",
        config: { CHAT_INBOUND_TOKEN: "test-chat-token" },
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);

    // Verify persistence
    const read = await authed("/admin/channels/config?service=channel-chat");
    const config = read.data.config as Record<string, string>;
    expect(config.CHAT_INBOUND_TOKEN).toBe("test-chat-token");
  });

  it("POST /admin/channels/config with voice channel (no config keys)", async () => {
    const r = await authed("/admin/channels/config", {
      method: "POST",
      body: JSON.stringify({
        service: "channel-voice",
        config: {},
      }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
  });
});

// ── Channel Access: Toggle for All Channels ─────────────
// Docs: Access toggle between lan and public per channel

describe("channel access for all platforms", () => {
  const validChannels = ["chat", "discord", "voice", "telegram"] as const;

  for (const channel of validChannels) {
    it(`POST /admin/channels/access toggles ${channel} to public then lan`, async () => {
      // Toggle to public
      const r1 = await authed("/admin/channels/access", {
        method: "POST",
        body: JSON.stringify({ channel, access: "public" }),
      });
      if (!r1.ok) console.log(`channel access ${channel}/public failure:`, JSON.stringify(r1.data));
      expect(r1.ok).toBe(true);
      expect(r1.data.channel).toBe(channel);
      expect(r1.data.access).toBe("public");

      // Toggle back to lan
      const r2 = await authed("/admin/channels/access", {
        method: "POST",
        body: JSON.stringify({ channel, access: "lan" }),
      });
      if (!r2.ok) console.log(`channel access ${channel}/lan failure:`, JSON.stringify(r2.data));
      expect(r2.ok).toBe(true);
      expect(r2.data.channel).toBe(channel);
      expect(r2.data.access).toBe("lan");
    });
  }
});

// ── Container Management: All Service Types ─────────────
// Docs: Allowed services list

describe("container management for all services", () => {
  const allowedServices = [
    "opencode-core", "gateway", "openmemory", "admin",
    "channel-chat", "channel-discord", "channel-voice", "channel-telegram", "caddy",
  ];

  for (const service of allowedServices) {
    it(`POST /admin/containers/up for ${service} returns 502 without controller`, async () => {
      const r = await authed("/admin/containers/up", {
        method: "POST",
        body: JSON.stringify({ service }),
      });
      expect(r.status).toBe(502);
      expect(r.data.ok).toBe(false);
      expect(r.data.error).toBe("controller not configured");
    });
  }

  for (const service of allowedServices) {
    it(`POST /admin/containers/down for ${service} returns 502 without controller`, async () => {
      const r = await authed("/admin/containers/down", {
        method: "POST",
        body: JSON.stringify({ service }),
      });
      expect(r.status).toBe(502);
      expect(r.data.ok).toBe(false);
      expect(r.data.error).toBe("controller not configured");
    });
  }

  for (const service of allowedServices) {
    it(`POST /admin/containers/restart for ${service} returns 502 without controller`, async () => {
      const r = await authed("/admin/containers/restart", {
        method: "POST",
        body: JSON.stringify({ service }),
      });
      expect(r.status).toBe(502);
      expect(r.data.ok).toBe(false);
      expect(r.data.error).toBe("controller not configured");
    });
  }
});

// ── Setup Wizard: Authed Channels & Service Instances ───
// Docs: POST /admin/setup/channels (after setup completion, with auth)

describe("setup wizard authed endpoints after completion", () => {
  it("POST /admin/setup/channels with auth succeeds after setup completion", async () => {
    const r = await authed("/admin/setup/channels", {
      method: "POST",
      body: JSON.stringify({ channels: ["channel-chat", "channel-voice"] }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
  });

  it("POST /admin/setup/service-instances with auth succeeds after setup completion", async () => {
    const r = await authed("/admin/setup/service-instances", {
      method: "POST",
      body: JSON.stringify({ openmemory: "", psql: "", qdrant: "" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
  });

  it("POST /admin/setup/step marks step complete with auth", async () => {
    const r = await authed("/admin/setup/step", {
      method: "POST",
      body: JSON.stringify({ step: "welcome" }),
    });
    expect(r.ok).toBe(true);
  });

  it("GET /admin/setup/status with auth returns full state after completion", async () => {
    const r = await authed("/admin/setup/status");
    expect(r.ok).toBe(true);
    expect(r.data.completed).toBe(true);
    expect(r.data).toHaveProperty("steps");
    expect(r.data).toHaveProperty("accessScope");
    expect(r.data).toHaveProperty("serviceInstances");
  });
});

// ── Cross-Cutting: Error Responses ──────────────────────
// Docs: meaningful error messages for API failures

describe("error response consistency", () => {
  it("invalid JSON body returns appropriate error", async () => {
    const r = await fetch(`${base}/admin/automations`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-token": "test-token-e2e" },
      body: "not valid json{{{",
    });
    // Server should handle gracefully
    expect([400, 500]).toContain(r.status);
  });

  it("unsupported HTTP method on known route returns appropriate status", async () => {
    const r = await api("/admin/channels", { method: "DELETE" });
    // Should get 401 (auth check) or 405 (method not allowed), not 500
    expect(r.status).toBeLessThan(500);
  });

  it("completely unknown API path returns SPA fallback or 404", async () => {
    const r = await api("/admin/this-does-not-exist-at-all");
    // Should serve SPA fallback (200) or 404, not 500
    expect([200, 404]).toContain(r.status);
  });
});

// ── CORS: Preflight for All Protected Endpoints ────────
// Docs: x-admin-token header allowed via CORS

describe("CORS preflight for protected endpoints", () => {
  const endpoints = [
    "/admin/channels",
    "/admin/automations",
    "/admin/providers",
    "/admin/config",
    "/admin/containers/up",
  ];

  for (const endpoint of endpoints) {
    it(`OPTIONS ${endpoint} returns 204 with correct CORS headers`, async () => {
      const r = await api(endpoint, { method: "OPTIONS" });
      expect(r.status).toBe(204);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(r.headers.get("access-control-allow-headers")).toContain("x-admin-token");
    });
  }
});

// ── Gallery: All Install Action Types ──────────────────
// Regression: Covers skill-file, compose-service, command-file, agent-file, tool-file installs

describe("gallery install action branches", () => {
  it("install skill-file item returns type skill-file", async () => {
    const r = await authed("/admin/gallery/install", {
      method: "POST",
      body: JSON.stringify({ galleryId: "skill-memory" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.type).toBe("skill-file");
    expect(r.data.installed).toBe("skill-memory");
  });

  it("install compose-service item returns type container", async () => {
    const r = await authed("/admin/gallery/install", {
      method: "POST",
      body: JSON.stringify({ galleryId: "channel-chat" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.type).toBe("container");
    expect(r.data.service).toBe("channel-chat");
    expect(r.data.installed).toBe("channel-chat");
  });

  it("install command-file item returns type command-file", async () => {
    // command-file, agent-file, and tool-file are now handled alongside skill-file
    // as built-in file-based extensions that get marked as enabled
    const r = await authed("/admin/gallery/install", {
      method: "POST",
      body: JSON.stringify({ galleryId: "command-health" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.type).toBe("command-file");
    expect(r.data.installed).toBe("command-health");
  });

  it("install via pluginId with valid npm package name", async () => {
    const r = await authed("/admin/gallery/install", {
      method: "POST",
      body: JSON.stringify({ pluginId: "@openpalm/test-plugin" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.pluginId).toBe("@openpalm/test-plugin");
  });

  it("install via pluginId with invalid identifier returns 400", async () => {
    const r = await authed("/admin/gallery/install", {
      method: "POST",
      body: JSON.stringify({ pluginId: "../etc/passwd" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("invalid plugin id");
  });
});

// ── Gallery: All Uninstall Action Types ─────────────────
// Regression: Covers plugin, compose-service, skill-file, and pluginId uninstalls

describe("gallery uninstall action branches", () => {
  it("uninstall compose-service item returns type container", async () => {
    const r = await authed("/admin/gallery/uninstall", {
      method: "POST",
      body: JSON.stringify({ galleryId: "channel-chat" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.type).toBe("container");
    expect(r.data.service).toBe("channel-chat");
  });

  it("uninstall skill-file item returns its installAction type", async () => {
    const r = await authed("/admin/gallery/uninstall", {
      method: "POST",
      body: JSON.stringify({ galleryId: "skill-memory" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.type).toBe("skill-file");
  });

  it("uninstall via pluginId with valid identifier", async () => {
    const r = await authed("/admin/gallery/uninstall", {
      method: "POST",
      body: JSON.stringify({ pluginId: "@openpalm/test-plugin" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
    expect(r.data.action).toBe("disabled");
  });

  it("uninstall via pluginId with invalid identifier returns 400", async () => {
    const r = await authed("/admin/gallery/uninstall", {
      method: "POST",
      body: JSON.stringify({ pluginId: "../../bad" }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("invalid plugin id");
  });
});

// ── Providers: OpenMemory Role Assignment ───────────────
// Regression: Ensures openmemory role assignment works (not just small)

describe("provider openmemory role assignment", () => {
  let testProviderId: string;

  it("create provider for openmemory assignment", async () => {
    const r = await authed("/admin/providers", {
      method: "POST",
      body: JSON.stringify({ name: "OpenMem Provider", url: "http://localhost:11435/v1", apiKey: "test-key" }),
    });
    expect(r.ok).toBe(true);
    testProviderId = (r.data.provider as Record<string, unknown>)?.id as string;
    expect(testProviderId).toBeTruthy();
  });

  it("assign openmemory role to provider", async () => {
    const r = await authed("/admin/providers/assign", {
      method: "POST",
      body: JSON.stringify({ role: "openmemory", providerId: testProviderId, modelId: "llama3:8b" }),
    });
    expect(r.ok).toBe(true);
    expect(r.data.assignments).toHaveProperty("openmemory");
    const assignments = r.data.assignments as Record<string, { providerId: string; modelId: string }>;
    const assignment = assignments.openmemory;
    expect(assignment.providerId).toBe(testProviderId);
    expect(assignment.modelId).toBe("llama3:8b");
  });

  it("GET /admin/providers reflects openmemory assignment", async () => {
    const r = await authed("/admin/providers");
    expect(r.ok).toBe(true);
    const assignments = r.data.assignments as Record<string, { providerId: string; modelId: string }> | undefined;
    const assignment = assignments?.openmemory;
    expect(assignment?.modelId).toBe("llama3:8b");
  });
});

// ── Automations: Missing ID Validation ──────────────────
// Regression: Ensures missing ID returns 400 for update, delete, trigger

describe("automations missing ID validation", () => {
  it("POST /admin/automations/update without id returns 400", async () => {
    const r = await authed("/admin/automations/update", {
      method: "POST",
      body: JSON.stringify({ name: "no-id" }),
    });
    expect(r.status).toBe(400);
  });

  it("POST /admin/automations/delete without id returns 400", async () => {
    const r = await authed("/admin/automations/delete", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });

  it("POST /admin/automations/trigger without id returns 400", async () => {
    const r = await authed("/admin/automations/trigger", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });
});

// ── Setup: Re-completion Auth Gate ──────────────────────
// Regression: After setup is complete, POST /admin/setup/complete requires auth

describe("setup re-completion auth gate", () => {
  it("POST /admin/setup/complete without auth after completion returns 401", async () => {
    const r = await apiJson("/admin/setup/complete", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(401);
  });

  it("POST /admin/setup/complete with auth after completion succeeds", async () => {
    const r = await authed("/admin/setup/complete", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(r.ok).toBe(true);
    expect(r.data.ok).toBe(true);
  });
});

// ── Provider Models: Error Handling ─────────────────────
// Regression: Ensures models endpoint handles various error states

describe("provider models edge cases", () => {
  it("POST /admin/providers/models with unknown provider returns 404", async () => {
    const r = await authed("/admin/providers/models", {
      method: "POST",
      body: JSON.stringify({ providerId: "nonexistent-provider-id" }),
    });
    expect(r.status).toBe(404);
  });

  it("POST /admin/providers/models without providerId returns 400", async () => {
    const r = await authed("/admin/providers/models", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(400);
  });
});

// ── Channel Access: Invalid Inputs ──────────────────────
// Regression: Ensures edge cases in channel access handling

describe("channel access edge cases", () => {
  it("POST /admin/channels/access with empty channel returns 400", async () => {
    const r = await authed("/admin/channels/access", {
      method: "POST",
      body: JSON.stringify({ channel: "", access: "lan" }),
    });
    expect(r.status).toBe(400);
  });

  it("POST /admin/channels/access with empty access returns 400", async () => {
    const r = await authed("/admin/channels/access", {
      method: "POST",
      body: JSON.stringify({ channel: "chat", access: "" }),
    });
    expect(r.status).toBe(400);
  });
});

// ── Static File Serving: Edge Cases ─────────────────────
// Regression: SPA fallback and asset serving edge cases

describe("static file serving edge cases", () => {
  it("GET /admin/ with trailing slash serves SPA", async () => {
    const r = await api("/admin/");
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain("html");
  });

  it("GET /logo.png serves the logo file", async () => {
    const r = await api("/logo.png");
    expect(r.status).toBe(200);
  });

  it("non-GET method on unknown path does not serve SPA", async () => {
    const r = await api("/admin/unknown-page", { method: "POST" });
    // Should return 404, not the SPA HTML
    expect(r.status).not.toBe(200);
  });
});

// ── Audit Regression Tests ──────────────────────────────────
// These tests cover specific bugs found and fixed during the security/quality audit.

// ── C1: detectChannelAccess regex fix ───────────────────────
// Regression: GET /admin/channels must return the correct access mode after toggling.

describe("C1: detectChannelAccess regex fix", () => {
  it("GET /admin/channels reflects access mode after toggling to lan", async () => {
    // Set channel-chat to "lan"
    const setLan = await authed("/admin/channels/access", {
      method: "POST",
      body: JSON.stringify({ channel: "chat", access: "lan" }),
    });
    expect(setLan.ok).toBe(true);

    // Verify GET /admin/channels reports access: "lan" for chat
    const list = await authed("/admin/channels");
    expect(list.ok).toBe(true);
    const channels = list.data.channels as Array<{ service: string; access: string }>;
    const chat = channels.find((c) => c.service === "channel-chat");
    expect(chat).toBeTruthy();
    expect(chat!.access).toBe("lan");
  });

  it("GET /admin/channels reflects access mode after toggling back to public", async () => {
    // Toggle back to "public"
    const setPublic = await authed("/admin/channels/access", {
      method: "POST",
      body: JSON.stringify({ channel: "chat", access: "public" }),
    });
    expect(setPublic.ok).toBe(true);

    // Verify GET /admin/channels reports access: "public" for chat
    const list = await authed("/admin/channels");
    expect(list.ok).toBe(true);
    const channels = list.data.channels as Array<{ service: string; access: string }>;
    const chat = channels.find((c) => c.service === "channel-chat");
    expect(chat).toBeTruthy();
    expect(chat!.access).toBe("public");
  });
});

// ── C2: Channel env file naming fix ─────────────────────────
// Regression: POST /admin/channels/config must write to the correct file
// and GET /admin/channels must return the saved config values.

describe("C2: channel env file naming fix", () => {
  it("saves discord config and reads it back via GET /admin/channels", async () => {
    // Save discord config
    const save = await authed("/admin/channels/config", {
      method: "POST",
      body: JSON.stringify({
        service: "channel-discord",
        config: { DISCORD_BOT_TOKEN: "c2-regression-token", DISCORD_PUBLIC_KEY: "c2-regression-key" },
      }),
    });
    expect(save.ok).toBe(true);

    // Read back via GET /admin/channels (which reads from the env file)
    const list = await authed("/admin/channels");
    expect(list.ok).toBe(true);
    const channels = list.data.channels as Array<{ service: string; config: Record<string, string> }>;
    const discord = channels.find((c) => c.service === "channel-discord");
    expect(discord).toBeTruthy();
    expect(discord!.config.DISCORD_BOT_TOKEN).toBe("c2-regression-token");
    expect(discord!.config.DISCORD_PUBLIC_KEY).toBe("c2-regression-key");
  });
});

// ── H4: removeExtension/removeChannel — uninstall removes from setup state ──

describe("H4: uninstall removes from installed list", () => {
  it("install then uninstall removes gallery item from GET /admin/installed", async () => {
    // Install a gallery item
    const install = await authed("/admin/gallery/install", {
      method: "POST",
      body: JSON.stringify({ galleryId: "plugin-policy-telemetry" }),
    });
    expect(install.ok).toBe(true);

    // Verify it appears in installed list
    const afterInstall = await authed("/admin/installed");
    expect(afterInstall.ok).toBe(true);
    const pluginsAfterInstall = afterInstall.data.plugins as string[];
    expect(pluginsAfterInstall.length).toBeGreaterThan(0);

    // Uninstall it
    const uninstall = await authed("/admin/gallery/uninstall", {
      method: "POST",
      body: JSON.stringify({ galleryId: "plugin-policy-telemetry" }),
    });
    expect(uninstall.ok).toBe(true);

    // Verify it is removed from installed list
    const afterUninstall = await authed("/admin/installed");
    expect(afterUninstall.ok).toBe(true);
    const pluginsAfterUninstall = afterUninstall.data.plugins as string[];
    // The plugin that was just uninstalled should no longer appear
    // (the list should be shorter or the specific plugin ID absent)
    expect(pluginsAfterUninstall.length).toBeLessThan(pluginsAfterInstall.length);
  });
});

// ── H15: Nested permission lint ─────────────────────────────
// Regression: Config with nested "allow" inside permission.tools must be rejected.

describe("H15: nested permission lint", () => {
  it("rejects config with nested allow in permission.tools", async () => {
    const config = JSON.stringify({
      permission: { tools: { bash: "allow" } },
    });
    const r = await authed("/admin/config", {
      method: "POST",
      body: JSON.stringify({ config }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("This change would weaken security protections and was blocked");
  });

  it("rejects config with deeply nested allow in permission tree", async () => {
    const config = JSON.stringify({
      permission: { tools: { "Bash(*)": { nested: "allow" } } },
    });
    const r = await authed("/admin/config", {
      method: "POST",
      body: JSON.stringify({ config }),
    });
    expect(r.status).toBe(400);
    expect(r.data.error).toBe("This change would weaken security protections and was blocked");
  });

  it("allows config with permission deny (not blocked)", async () => {
    const config = JSON.stringify({
      permission: { tools: { bash: "deny" } },
    });
    const r = await authed("/admin/config", {
      method: "POST",
      body: JSON.stringify({ config, restart: false }),
    });
    expect(r.ok).toBe(true);
  });
});

// ── M3: Automation name newline injection ───────────────────
// Regression: Creating an automation with newline in name must not crash
// and the name must be sanitized in the crontab output.

describe("M3: automation name newline injection", () => {
  let injectionId: string;

  it("creating automation with newline in name does not crash", async () => {
    const r = await authed("/admin/automations", {
      method: "POST",
      body: JSON.stringify({
        name: "Inject\nNewline",
        schedule: "0 0 * * *",
        prompt: "test newline injection",
      }),
    });
    expect(r.status).toBe(201);
    expect(r.data.ok).toBe(true);
    injectionId = (r.data.automation as Record<string, unknown>).id as string;
    expect(injectionId).toBeTruthy();
  });

  it("automation with newline name appears in list", async () => {
    const r = await authed("/admin/automations");
    expect(r.ok).toBe(true);
    const automations = r.data.automations as Array<{ id: string }>;
    expect(automations.some((a) => a.id === injectionId)).toBe(true);
  });

  it("cleanup: delete the injected automation", async () => {
    const r = await authed("/admin/automations/delete", {
      method: "POST",
      body: JSON.stringify({ id: injectionId }),
    });
    expect(r.ok).toBe(true);
  });
});

// ── M11: Duplicate provider name ────────────────────────────
// Regression: Creating two providers with the same name must return 409.

describe("M11: duplicate provider name", () => {
  let firstProviderId: string;

  it("creating first provider succeeds", async () => {
    const r = await authed("/admin/providers", {
      method: "POST",
      body: JSON.stringify({ name: "Test Provider Duplicate", url: "http://localhost:11434/v1", apiKey: "key1" }),
    });
    expect(r.status).toBe(201);
    expect(r.data.ok).toBe(true);
    firstProviderId = (r.data.provider as Record<string, unknown>).id as string;
  });

  it("creating second provider with same name returns 409", async () => {
    const r = await authed("/admin/providers", {
      method: "POST",
      body: JSON.stringify({ name: "Test Provider Duplicate", url: "http://localhost:11435/v1", apiKey: "key2" }),
    });
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("a provider with this name already exists");
  });

  it("case-insensitive duplicate also returns 409", async () => {
    const r = await authed("/admin/providers", {
      method: "POST",
      body: JSON.stringify({ name: "test provider duplicate", url: "http://localhost:11436/v1", apiKey: "key3" }),
    });
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("a provider with this name already exists");
  });

  it("cleanup: delete the test provider", async () => {
    const r = await authed("/admin/providers/delete", {
      method: "POST",
      body: JSON.stringify({ id: firstProviderId }),
    });
    expect(r.ok).toBe(true);
  });
});
