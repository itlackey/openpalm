import { readFileSync, existsSync, writeFileSync, copyFileSync, mkdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, extname } from "node:path";
import { updatePluginListAtomically, validatePluginIdentifier } from "./extensions.ts";
import { parseJsonc, stringifyPretty } from "./jsonc.ts";
import { searchGallery, getGalleryItem, listGalleryCategories, searchNpm, getRiskBadge, searchPublicRegistry, fetchPublicRegistry, getPublicRegistryItem } from "./gallery.ts";
import { SetupManager } from "./setup.ts";
import { AutomationStore, validateCron } from "./automation-store.ts";
import { ProviderStore } from "./provider-store.ts";
import { parseRuntimeEnvContent, sanitizeEnvScalar, setRuntimeBindScopeContent, updateRuntimeEnvContent } from "./runtime-env.ts";
import type { GalleryCategory } from "./gallery.ts";
import type { ModelAssignment } from "./types.ts";

// TODO: Split this file into route modules as it grows:
//   routes/setup.ts       - Setup wizard endpoints (/admin/setup/*)
//   routes/gallery.ts     - Extension gallery endpoints (/admin/gallery/*)
//   routes/channels.ts    - Channel management endpoints (/admin/channels/*)
//   routes/automations.ts - Automation CRUD endpoints (/admin/automations/*)
//   routes/providers.ts   - Provider management endpoints (/admin/providers/*)
//   routes/system.ts      - System/config endpoints (/admin/containers/*, /admin/config/*)

const PORT = Number(Bun.env.PORT ?? 8100);
const ADMIN_TOKEN = Bun.env.ADMIN_TOKEN ?? "change-me-admin-token";
const OPENCODE_CONFIG_PATH = Bun.env.OPENCODE_CONFIG_PATH ?? "/app/config/opencode.jsonc";
const DATA_DIR = Bun.env.DATA_DIR ?? "/app/data";
const CONTROLLER_URL = Bun.env.CONTROLLER_URL;
const CONTROLLER_TOKEN = Bun.env.CONTROLLER_TOKEN ?? "";
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const CADDYFILE_PATH = Bun.env.CADDYFILE_PATH ?? "/app/config/Caddyfile";
const CHANNEL_ENV_DIR = Bun.env.CHANNEL_ENV_DIR ?? "/app/channel-env";
const OPENCODE_CORE_URL = Bun.env.OPENCODE_CORE_URL ?? "http://opencode-core:4096";
const OPENMEMORY_URL = Bun.env.OPENMEMORY_URL ?? "http://openmemory:8765";
const OPENCODE_CORE_CONFIG_DIR = Bun.env.OPENCODE_CORE_CONFIG_DIR ?? "/app/config/opencode-core";
const CRON_DIR = Bun.env.CRON_DIR ?? "/app/config-root/cron";
const RUNTIME_ENV_PATH = Bun.env.RUNTIME_ENV_PATH ?? "/workspace/.env";
const SECRETS_ENV_PATH = Bun.env.SECRETS_ENV_PATH ?? "/app/config-root/secrets.env";
const UI_DIR = Bun.env.UI_DIR ?? "/app/ui/build";
const CHANNEL_SERVICES = ["channel-chat", "channel-discord", "channel-voice", "channel-telegram"] as const;
const CHANNEL_SERVICE_SET = new Set<string>(CHANNEL_SERVICES);
const KNOWN_SERVICES = new Set<string>([
  "gateway", "controller", "opencode-core", "openmemory", "openmemory-ui",
  "admin", "caddy",
  "channel-chat", "channel-discord", "channel-voice", "channel-telegram"
]);
const CHANNEL_ENV_KEYS: Record<string, string[]> = {
  "channel-chat": ["CHAT_INBOUND_TOKEN"],
  "channel-discord": ["DISCORD_BOT_TOKEN", "DISCORD_PUBLIC_KEY"],
  "channel-voice": [],
  "channel-telegram": ["TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET"]
};

const setupManager = new SetupManager(DATA_DIR);
const automationStore = new AutomationStore(DATA_DIR, CRON_DIR);
const providerStore = new ProviderStore(DATA_DIR);

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function cors(resp: Response): Response {
  resp.headers.set("access-control-allow-origin", "*");
  resp.headers.set("access-control-allow-headers", "content-type, x-admin-token, x-request-id");
  resp.headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  return resp;
}

function auth(req: Request) {
  return req.headers.get("x-admin-token") === ADMIN_TOKEN;
}

async function controllerAction(action: string, service: string, reason: string) {
  if (!CONTROLLER_URL) return;
  try {
    await fetch(`${CONTROLLER_URL}/${action}/${service}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-controller-token": CONTROLLER_TOKEN
      },
      body: JSON.stringify({ reason })
    });
  } catch (err) {
    console.error(`[controllerAction] ${action}/${service} failed:`, err);
  }
}

function snapshotFile(path: string) {
  const backup = `${path}.${Date.now()}.bak`;
  copyFileSync(path, backup);
  return backup;
}



function ensureOpencodeConfigPath() {
  if (existsSync(OPENCODE_CONFIG_PATH)) return;
  mkdirSync(dirname(OPENCODE_CONFIG_PATH), { recursive: true });
  writeFileSync(OPENCODE_CONFIG_PATH, "{}\n", "utf8");
}



type ChannelName = "chat" | "voice" | "discord" | "telegram";

function channelRewritePath(channel: ChannelName) {
  if (channel === "chat") return "/chat";
  if (channel === "voice") return "/voice/transcription";
  if (channel === "discord") return "/discord/webhook";
  return "/telegram/webhook";
}

function channelPort(channel: ChannelName) {
  if (channel === "chat") return "8181";
  if (channel === "voice") return "8183";
  if (channel === "discord") return "8184";
  return "8182";
}

function detectChannelAccess(channel: ChannelName): "lan" | "public" {
  const raw = readFileSync(CADDYFILE_PATH, "utf8");
  const block = raw.match(new RegExp(`handle /channels/${channel}\\* \\{[\\s\\S]*?\\n\\}`, "m"))?.[0] ?? "";
  return block.includes("abort @not_lan") ? "lan" : "public";
}

function setChannelAccess(channel: ChannelName, access: "lan" | "public") {
  const raw = readFileSync(CADDYFILE_PATH, "utf8");
  const blockRegex = new RegExp(`handle /channels/${channel}\\* \\{[\\s\\S]*?\\n[ \\t]*\\}`, "m");
  const replacement = access === "lan"
    ? [
      `handle /channels/${channel}* {`,
      `		abort @not_lan`,
      `		rewrite * ${channelRewritePath(channel)}`,
      `		reverse_proxy channel-${channel}:${channelPort(channel)}`,
      `	}`
    ].join("\n")
    : [
      `handle /channels/${channel}* {`,
      `		rewrite * ${channelRewritePath(channel)}`,
      `		reverse_proxy channel-${channel}:${channelPort(channel)}`,
      `	}`
    ].join("\n");

  if (!blockRegex.test(raw)) throw new Error(`missing_${channel}_route_block`);
  writeFileSync(CADDYFILE_PATH, raw.replace(blockRegex, replacement), "utf8");
}

function channelEnvPath(service: string) {
  return `${CHANNEL_ENV_DIR}/${service}.env`;
}

function readChannelConfig(service: string) {
  const keys = CHANNEL_ENV_KEYS[service] ?? [];
  const path = channelEnvPath(service);
  const cfg: Record<string, string> = {};
  for (const k of keys) cfg[k] = "";
  if (!existsSync(path)) return cfg;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [k, ...rest] = line.split("=");
    if (keys.includes(k.trim())) cfg[k.trim()] = rest.join("=").trim();
  }
  return cfg;
}

function writeChannelConfig(service: string, values: Record<string, string>) {
  const keys = CHANNEL_ENV_KEYS[service] ?? [];
  const lines = ["# Channel-specific overrides managed by admin UI"];
  for (const k of keys) {
    const v = String(values[k] ?? "").replace(/\n/g, "").trim();
    lines.push(`${k}=${v}`);
  }
  writeFileSync(channelEnvPath(service), lines.join("\n") + "\n", "utf8");
}

function setAccessScope(scope: "host" | "lan") {
  const raw = readFileSync(CADDYFILE_PATH, "utf8");
  const lanRanges = "127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 ::1 fd00::/8";
  const hostRanges = "127.0.0.0/8 ::1";
  const lanMatcher = scope === "host"
    ? `@lan remote_ip ${hostRanges}`
    : `@lan remote_ip ${lanRanges}`;
  const notLanMatcher = scope === "host"
    ? `@not_lan not remote_ip ${hostRanges}`
    : `@not_lan not remote_ip ${lanRanges}`;

  const next = raw
    .replace(/^\s*@lan remote_ip .+$/m, `\t${lanMatcher}`)
    .replace(/^\s*@not_lan not remote_ip .+$/m, `\t${notLanMatcher}`);
  writeFileSync(CADDYFILE_PATH, next, "utf8");
}

function setRuntimeBindScope(scope: "host" | "lan") {
  const current = existsSync(RUNTIME_ENV_PATH) ? readFileSync(RUNTIME_ENV_PATH, "utf8") : "";
  const next = setRuntimeBindScopeContent(current, scope);
  writeFileSync(RUNTIME_ENV_PATH, next, "utf8");
}

function updateRuntimeEnv(entries: Record<string, string | undefined>) {
  const current = existsSync(RUNTIME_ENV_PATH) ? readFileSync(RUNTIME_ENV_PATH, "utf8") : "";
  const next = updateRuntimeEnvContent(current, entries);
  writeFileSync(RUNTIME_ENV_PATH, next, "utf8");
}

function normalizeSelectedChannels(value: unknown) {
  if (!Array.isArray(value)) return [];
  const selected: string[] = [];
  for (const service of value) {
    if (typeof service !== "string") continue;
    if (!CHANNEL_SERVICE_SET.has(service)) continue;
    if (selected.includes(service)) continue;
    selected.push(service);
  }
  return selected;
}

function readRuntimeEnv() {
  if (!existsSync(RUNTIME_ENV_PATH)) return {};
  return parseRuntimeEnvContent(readFileSync(RUNTIME_ENV_PATH, "utf8"));
}

function readSecretsEnv() {
  if (!existsSync(SECRETS_ENV_PATH)) return {};
  return parseRuntimeEnvContent(readFileSync(SECRETS_ENV_PATH, "utf8"));
}

function updateSecretsEnv(entries: Record<string, string | undefined>) {
  const current = existsSync(SECRETS_ENV_PATH) ? readFileSync(SECRETS_ENV_PATH, "utf8") : "";
  const next = updateRuntimeEnvContent(current, entries);
  writeFileSync(SECRETS_ENV_PATH, next, "utf8");
}

function getConfiguredServiceInstances() {
  const runtime = readRuntimeEnv();
  const state = setupManager.getState();
  return {
    openmemory: runtime.OPENMEMORY_URL ?? state.serviceInstances.openmemory ?? "",
    psql: runtime.OPENMEMORY_POSTGRES_URL ?? state.serviceInstances.psql ?? "",
    qdrant: runtime.OPENMEMORY_QDRANT_URL ?? state.serviceInstances.qdrant ?? "",
  };
}

function getConfiguredOpenmemoryProvider() {
  const secrets = readSecretsEnv();
  return {
    openaiBaseUrl: secrets.OPENAI_BASE_URL ?? "",
    openaiApiKeyConfigured: Boolean(secrets.OPENAI_API_KEY)
  };
}

function getConfiguredSmallModel() {
  const state = setupManager.getState();
  const secrets = readSecretsEnv();
  return {
    endpoint: state.smallModel.endpoint,
    modelId: state.smallModel.modelId,
    apiKeyConfigured: Boolean(secrets.OPENPALM_SMALL_MODEL_API_KEY)
  };
}

function applySmallModelToOpencodeConfig(endpoint: string, modelId: string) {
  if (!modelId || !existsSync(OPENCODE_CONFIG_PATH)) return;
  const raw = readFileSync(OPENCODE_CONFIG_PATH, "utf8");
  const doc = parseJsonc(raw) as Record<string, unknown>;
  doc.small_model = modelId;
  if (endpoint) {
    const parts = modelId.split("/");
    const providerId = parts.length > 1 ? parts[0] : "openpalm-small";
    const providers = (typeof doc.provider === "object" && doc.provider !== null) ? { ...doc.provider as Record<string, unknown> } : {};
    const providerOptions: Record<string, unknown> = { baseURL: endpoint };
    providerOptions.apiKey = "{env:OPENPALM_SMALL_MODEL_API_KEY}";
    providers[providerId] = { options: providerOptions };
    doc.provider = providers;
  }
  const next = stringifyPretty(doc);
  writeFileSync(OPENCODE_CONFIG_PATH, next, "utf8");
}

function applyProviderAssignment(role: ModelAssignment, providerUrl: string, providerApiKey: string, modelId: string) {
  if (role === "small") {
    const secretKey = "OPENPALM_SMALL_MODEL_API_KEY";
    updateSecretsEnv({ [secretKey]: providerApiKey || undefined });
    applySmallModelToOpencodeConfig(providerUrl, modelId);
    setupManager.setSmallModel({ endpoint: providerUrl, modelId });
  } else if (role === "openmemory") {
    updateSecretsEnv({
      OPENAI_BASE_URL: providerUrl || undefined,
      OPENAI_API_KEY: providerApiKey || undefined,
    });
  }
}

async function fetchModelsFromProvider(url: string, apiKey: string): Promise<{ id: string; object?: string }[]> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("invalid provider URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("provider URL must use http or https");
  const modelsUrl = url.replace(/\/+$/, "") + "/models";
  const headers: Record<string, string> = { "accept": "application/json" };
  if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
  const resp = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) throw new Error(`provider returned status ${resp.status}`);
  const body = await resp.json() as { data?: { id: string; object?: string }[] };
  if (!Array.isArray(body.data)) throw new Error("unexpected response format: missing data array");
  return body.data;
}

async function checkServiceHealth(url: string, expectJson = true): Promise<{ ok: boolean; time?: string; error?: string }> {
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return { ok: false, error: `status ${resp.status}` };
    if (!expectJson) return { ok: true, time: new Date().toISOString() };
    const body = await resp.json() as { ok?: boolean; time?: string };
    return { ok: body.ok ?? true, time: body.time };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function normalizeServiceInstanceUrl(value: unknown): string {
  return sanitizeEnvScalar(value);
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }));
    }

    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    try {
      const url = new URL(req.url);

      // ── Health ────────────────────────────────────────────────────
      if (url.pathname === "/health" && req.method === "GET") {
        return cors(json(200, { ok: true, service: "admin", time: new Date().toISOString() }));
      }

      // ── Meta (display names) ────────────────────────────────────────
      if (url.pathname === "/admin/meta" && req.method === "GET") {
        return cors(json(200, {
          serviceNames: {
            gateway: { label: "Message Router", description: "Routes messages between channels and your assistant" },
            controller: { label: "System Manager", description: "Manages background services" },
            opencodeCore: { label: "AI Assistant", description: "The core assistant engine" },
            "opencode-core": { label: "AI Assistant", description: "The core assistant engine" },
            openmemory: { label: "Memory", description: "Stores conversation history and context" },
            "openmemory-ui": { label: "Memory Dashboard", description: "Visual interface for memory data" },
            admin: { label: "Admin Panel", description: "This management interface" },
            "channel-chat": { label: "Chat Channel", description: "Web chat interface" },
            "channel-discord": { label: "Discord Channel", description: "Discord bot connection" },
            "channel-voice": { label: "Voice Channel", description: "Voice input interface" },
            "channel-telegram": { label: "Telegram Channel", description: "Telegram bot connection" },
            caddy: { label: "Web Server", description: "Handles secure connections" }
          },
          channelFields: {
            "channel-chat": [
              { key: "CHAT_INBOUND_TOKEN", label: "Inbound Token", type: "password", required: false, helpText: "Token for authenticating incoming chat messages" }
            ],
            "channel-discord": [
              { key: "DISCORD_BOT_TOKEN", label: "Bot Token", type: "password", required: true, helpText: "Create a bot at discord.com/developers and copy the token" },
              { key: "DISCORD_PUBLIC_KEY", label: "Public Key", type: "text", required: true, helpText: "Found on the same page as your bot token" }
            ],
            "channel-voice": [],
            "channel-telegram": [
              { key: "TELEGRAM_BOT_TOKEN", label: "Bot Token", type: "password", required: true, helpText: "Get a bot token from @BotFather on Telegram" },
              { key: "TELEGRAM_WEBHOOK_SECRET", label: "Webhook Secret", type: "password", required: false, helpText: "A secret string to verify incoming webhook requests" }
            ]
          }
        }));
      }

      // ── Setup wizard ──────────────────────────────────────────────
      if (url.pathname === "/admin/setup/status" && req.method === "GET") {
        const state = setupManager.getState();
        if (state.completed === true && !auth(req)) return cors(json(401, { error: "admin token required" }));
        const secrets = readSecretsEnv();
        return cors(json(200, {
          ...state,
          serviceInstances: getConfiguredServiceInstances(),
          openmemoryProvider: getConfiguredOpenmemoryProvider(),
          smallModelProvider: getConfiguredSmallModel(),
          anthropicKeyConfigured: Boolean(secrets.ANTHROPIC_API_KEY),
          firstBoot: setupManager.isFirstBoot()
        }));
      }

      if (url.pathname === "/admin/setup/step" && req.method === "POST") {
        const body = (await req.json()) as { step: string };
        const validSteps = ["welcome", "accessScope", "serviceInstances", "healthCheck", "security", "channels", "extensions"];
        if (!validSteps.includes(body.step)) return cors(json(400, { error: "invalid step" }));
        const state = setupManager.completeStep(body.step as "welcome" | "accessScope" | "serviceInstances" | "healthCheck" | "security" | "channels" | "extensions");
        return cors(json(200, { ok: true, state }));
      }

      if (url.pathname === "/admin/setup/access-scope" && req.method === "POST") {
        const body = (await req.json()) as { scope: "host" | "lan" };
        if (!["host", "lan"].includes(body.scope)) return cors(json(400, { error: "invalid scope" }));
        const current = setupManager.getState();
        if (current.completed && !auth(req)) return cors(json(401, { error: "admin token required" }));
        setAccessScope(body.scope);
        setRuntimeBindScope(body.scope);
        await Promise.all([
          controllerAction("up", "caddy", `setup scope: ${body.scope}`),
          controllerAction("up", "openmemory", `setup scope: ${body.scope}`),
          controllerAction("up", "opencode-core", `setup scope: ${body.scope}`),
        ]);
        const state = setupManager.setAccessScope(body.scope);
        return cors(json(200, { ok: true, state }));
      }

      if (url.pathname === "/admin/setup/complete" && req.method === "POST") {
        const current = setupManager.getState();
        if (current.completed === true && !auth(req)) return cors(json(401, { error: "admin token required" }));
        const state = setupManager.completeSetup();
        return cors(json(200, { ok: true, state }));
      }

      if (url.pathname === "/admin/setup/service-instances" && req.method === "POST") {
        const body = (await req.json()) as { openmemory?: string; psql?: string; qdrant?: string; openaiBaseUrl?: string; openaiApiKey?: string; anthropicApiKey?: string; smallModelEndpoint?: string; smallModelApiKey?: string; smallModelId?: string };
        const current = setupManager.getState();
        if (current.completed && !auth(req)) return cors(json(401, { error: "admin token required" }));
        const openmemory = normalizeServiceInstanceUrl(body.openmemory);
        const psql = normalizeServiceInstanceUrl(body.psql);
        const qdrant = normalizeServiceInstanceUrl(body.qdrant);
        const openaiBaseUrl = sanitizeEnvScalar(body.openaiBaseUrl);
        const openaiApiKey = sanitizeEnvScalar(body.openaiApiKey);
        const anthropicApiKey = sanitizeEnvScalar(body.anthropicApiKey);
        const smallModelEndpoint = sanitizeEnvScalar(body.smallModelEndpoint);
        const smallModelApiKey = sanitizeEnvScalar(body.smallModelApiKey);
        const smallModelId = sanitizeEnvScalar(body.smallModelId);
        updateRuntimeEnv({
          OPENMEMORY_URL: openmemory || undefined,
          OPENMEMORY_POSTGRES_URL: psql || undefined,
          OPENMEMORY_QDRANT_URL: qdrant || undefined
        });
        const secretEntries: Record<string, string | undefined> = {
          OPENAI_BASE_URL: openaiBaseUrl || undefined
        };
        if (openaiApiKey.length > 0) {
          secretEntries.OPENAI_API_KEY = openaiApiKey;
        }
        if (anthropicApiKey.length > 0) {
          secretEntries.ANTHROPIC_API_KEY = anthropicApiKey;
        }
        if (smallModelApiKey.length > 0) {
          secretEntries.OPENPALM_SMALL_MODEL_API_KEY = smallModelApiKey;
        }
        updateSecretsEnv(secretEntries);
        const state = setupManager.setServiceInstances({ openmemory, psql, qdrant });
        if (smallModelId) {
          setupManager.setSmallModel({ endpoint: smallModelEndpoint, modelId: smallModelId });
          applySmallModelToOpencodeConfig(smallModelEndpoint, smallModelId);
        }
        return cors(json(200, { ok: true, state, openmemoryProvider: getConfiguredOpenmemoryProvider(), smallModelProvider: getConfiguredSmallModel() }));
      }

      if (url.pathname === "/admin/setup/channels" && req.method === "POST") {
        const body = (await req.json()) as { channels?: unknown };
        const current = setupManager.getState();
        if (current.completed && !auth(req)) return cors(json(401, { error: "admin token required" }));
        const channels = normalizeSelectedChannels(body.channels);
        updateRuntimeEnv({ OPENPALM_ENABLED_CHANNELS: channels.length ? channels.join(",") : undefined });
        const state = setupManager.setEnabledChannels(channels);
        return cors(json(200, { ok: true, state }));
      }

      if (url.pathname === "/admin/setup/health-check" && req.method === "GET") {
        const serviceInstances = getConfiguredServiceInstances();
        const openmemoryBaseUrl = serviceInstances.openmemory || OPENMEMORY_URL;
        const [gateway, controller, opencodeCore, openmemory] = await Promise.all([
          checkServiceHealth(`${GATEWAY_URL}/health`),
          CONTROLLER_URL ? checkServiceHealth(`${CONTROLLER_URL}/health`) : Promise.resolve({ ok: false, error: "not configured" }),
          checkServiceHealth(`${OPENCODE_CORE_URL}/`, false),
          checkServiceHealth(`${openmemoryBaseUrl}/api/v1/config/`)
        ]);
        return cors(json(200, {
          services: {
            gateway,
            controller,
            opencodeCore,
            openmemory,
            admin: { ok: true, time: new Date().toISOString() }
          },
          serviceInstances
        }));
      }

      // ── Gallery ───────────────────────────────────────────────────
      if (url.pathname === "/admin/gallery/search" && req.method === "GET") {
        const query = url.searchParams.get("q") ?? "";
        const category = url.searchParams.get("category") as GalleryCategory | null;
        const items = searchGallery(query, category ?? undefined);
        return cors(json(200, { items, total: items.length }));
      }

      if (url.pathname === "/admin/gallery/categories" && req.method === "GET") {
        return cors(json(200, { categories: listGalleryCategories() }));
      }

      if (url.pathname.startsWith("/admin/gallery/item/") && req.method === "GET") {
        const id = url.pathname.replace("/admin/gallery/item/", "");
        const item = getGalleryItem(id);
        if (!item) return cors(json(404, { error: "item not found" }));
        const badge = getRiskBadge(item.risk);
        return cors(json(200, { item, riskBadge: badge }));
      }

      if (url.pathname === "/admin/gallery/npm-search" && req.method === "GET") {
        const query = url.searchParams.get("q") ?? "";
        if (!query) return cors(json(400, { error: "query required" }));
        const results = await searchNpm(query);
        return cors(json(200, { results }));
      }

      // Community registry — fetched at runtime from the registry/ folder on GitHub.
      // No auth required (read-only, public data). Results are cached for 10 minutes.
      if (url.pathname === "/admin/gallery/community" && req.method === "GET") {
        const query = url.searchParams.get("q") ?? "";
        const category = url.searchParams.get("category") as GalleryCategory | null;
        const items = await searchPublicRegistry(query, category ?? undefined);
        return cors(json(200, { items, total: items.length, source: "community-registry" }));
      }

      // Force a cache refresh of the community registry index
      if (url.pathname === "/admin/gallery/community/refresh" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const items = await fetchPublicRegistry(true);
        return cors(json(200, { ok: true, total: items.length, refreshedAt: new Date().toISOString() }));
      }

      if (url.pathname === "/admin/gallery/install" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { galleryId?: string; pluginId?: string };

        if (body.galleryId) {
          // Look up in curated gallery first, then fall back to community registry
          const item = getGalleryItem(body.galleryId) ?? await getPublicRegistryItem(body.galleryId);
          if (!item) return cors(json(404, { error: "gallery item not found" }));

          if (item.installAction === "plugin") {
            const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, item.installTarget, true);
            await controllerAction("restart", "opencode-core", `gallery install: ${item.name}`);
            setupManager.addExtension(item.id);
            return cors(json(200, { ok: true, installed: item.id, type: "plugin", result }));
          }

          if (item.installAction === "skill-file") {
            setupManager.addExtension(item.id);
            return cors(json(200, { ok: true, installed: item.id, type: "skill", note: "Skill files ship with OpenPalm. Marked as enabled." }));
          }

          if (item.installAction === "compose-service") {
            await controllerAction("up", item.installTarget, `gallery install: ${item.name}`);
            setupManager.addExtension(item.id);
            setupManager.addChannel(item.installTarget);
            return cors(json(200, { ok: true, installed: item.id, type: "container", service: item.installTarget }));
          }

          return cors(json(400, { error: "unknown install action" }));
        }

        if (body.pluginId) {
          if (!validatePluginIdentifier(body.pluginId)) return cors(json(400, { error: "invalid plugin id" }));
          const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, body.pluginId, true);
          await controllerAction("restart", "opencode-core", `npm plugin install: ${body.pluginId}`);
          return cors(json(200, { ok: true, pluginId: body.pluginId, result }));
        }

        return cors(json(400, { error: "galleryId or pluginId required" }));
      }

      if (url.pathname === "/admin/gallery/uninstall" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { galleryId?: string; pluginId?: string };

        if (body.galleryId) {
          // Look up in curated gallery first, then fall back to community registry
          const item = getGalleryItem(body.galleryId) ?? await getPublicRegistryItem(body.galleryId);
          if (!item) return cors(json(404, { error: "gallery item not found" }));
          if (item.installAction === "plugin") {
            const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, item.installTarget, false);
            await controllerAction("restart", "opencode-core", `gallery uninstall: ${item.name}`);
            return cors(json(200, { ok: true, uninstalled: item.id, type: "plugin", result }));
          }
          if (item.installAction === "compose-service") {
            await controllerAction("down", item.installTarget, `gallery uninstall: ${item.name}`);
            return cors(json(200, { ok: true, uninstalled: item.id, type: "container", service: item.installTarget }));
          }
          return cors(json(200, { ok: true, uninstalled: item.id, type: item.installAction }));
        }

        if (body.pluginId) {
          if (!validatePluginIdentifier(body.pluginId)) return cors(json(400, { error: "invalid plugin id" }));
          const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, body.pluginId, false);
          await controllerAction("restart", "opencode-core", `plugin uninstall: ${body.pluginId}`);
          return cors(json(200, { ok: true, action: "disabled", result }));
        }

        return cors(json(400, { error: "galleryId or pluginId required" }));
      }

      // ── Installed status ──────────────────────────────────────────
      if (url.pathname === "/admin/installed" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const state = setupManager.getState();
        ensureOpencodeConfigPath();
        const configRaw = readFileSync(OPENCODE_CONFIG_PATH, "utf8");
        const config = parseJsonc(configRaw) as { plugin?: string[] };
        return cors(json(200, {
          plugins: config.plugin ?? [],
          setupState: state
        }));
      }

      // ── Container management ──────────────────────────────────────
      if (url.pathname === "/admin/containers/list" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        if (!CONTROLLER_URL) return cors(json(503, { error: "controller not configured" }));
        const resp = await fetch(`${CONTROLLER_URL}/containers`, {
          headers: { "x-controller-token": CONTROLLER_TOKEN }
        });
        return cors(new Response(await resp.text(), { status: resp.status, headers: { "content-type": "application/json" } }));
      }

      if (url.pathname === "/admin/containers/up" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string };
        if (!body.service || !KNOWN_SERVICES.has(body.service)) return cors(json(400, { error: "unknown service name" }));
        await controllerAction("up", body.service, "admin action");
        return cors(json(200, { ok: true, action: "up", service: body.service }));
      }

      if (url.pathname === "/admin/containers/down" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string };
        if (!body.service || !KNOWN_SERVICES.has(body.service)) return cors(json(400, { error: "unknown service name" }));
        await controllerAction("down", body.service, "admin action");
        return cors(json(200, { ok: true, action: "down", service: body.service }));
      }

      if (url.pathname === "/admin/containers/restart" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string };
        if (!body.service || !KNOWN_SERVICES.has(body.service)) return cors(json(400, { error: "unknown service name" }));
        await controllerAction("restart", body.service, "admin action");
        return cors(json(200, { ok: true, action: "restart", service: body.service }));
      }

      if (url.pathname === "/admin/channels" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        return cors(json(200, {
          channels: CHANNEL_SERVICES.map((service) => {
            const channelName = service.replace("channel-", "") as ChannelName;
            return {
              service,
              label: channelName.charAt(0).toUpperCase() + channelName.slice(1),
              access: detectChannelAccess(channelName),
              config: readChannelConfig(service),
              fields: (CHANNEL_ENV_KEYS[service] ?? []).map((key) => ({
                key,
                label: key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^(Discord|Telegram|Chat) /, ""),
                type: key.toLowerCase().includes("token") || key.toLowerCase().includes("key") || key.toLowerCase().includes("secret") ? "password" : "text",
                required: key.includes("BOT_TOKEN"),
              }))
            };
          })
        }));
      }

      if (url.pathname === "/admin/channels/access" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { channel: ChannelName; access: "lan" | "public" };
        if (!["chat", "voice", "discord", "telegram"].includes(body.channel)) return cors(json(400, { error: "invalid channel" }));
        if (!["lan", "public"].includes(body.access)) return cors(json(400, { error: "invalid access" }));
        setChannelAccess(body.channel, body.access);
        await controllerAction("restart", "caddy", `channel ${body.channel} access ${body.access}`);
        return cors(json(200, { ok: true, channel: body.channel, access: body.access }));
      }

      if (url.pathname === "/admin/channels/config" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const service = url.searchParams.get("service") ?? "";
        if (!CHANNEL_SERVICES.includes(service as (typeof CHANNEL_SERVICES)[number])) return cors(json(400, { error: "invalid service" }));
        return cors(json(200, { service, config: readChannelConfig(service) }));
      }

      if (url.pathname === "/admin/channels/config" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string; config: Record<string, string>; restart?: boolean };
        if (!CHANNEL_SERVICES.includes(body.service as (typeof CHANNEL_SERVICES)[number])) return cors(json(400, { error: "invalid service" }));
        writeChannelConfig(body.service, body.config ?? {});
        if (body.restart ?? true) await controllerAction("restart", body.service, "channel config update");
        return cors(json(200, { ok: true, service: body.service }));
      }

      // ── Automations ────────────────────────────────────────────────
      if (url.pathname === "/admin/automations" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        return cors(json(200, { automations: automationStore.list() }));
      }

      if (url.pathname === "/admin/automations" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { name?: string; schedule?: string; prompt?: string };
        if (!body.name || !body.schedule || !body.prompt) {
          return cors(json(400, { error: "name, schedule, and prompt are required" }));
        }
        const cronError = validateCron(body.schedule);
        if (cronError) return cors(json(400, { error: `invalid cron expression: ${cronError}` }));
        const automation = {
          id: randomUUID(),
          name: body.name,
          schedule: body.schedule,
          prompt: body.prompt,
          status: "enabled" as const,
          createdAt: new Date().toISOString(),
        };
        automationStore.add(automation);
        automationStore.writeCrontab();
        await controllerAction("restart", "opencode-core", `automation created: ${automation.name}`);
        return cors(json(201, { ok: true, automation }));
      }

      if (url.pathname === "/admin/automations/update" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string; name?: string; schedule?: string; prompt?: string; status?: "enabled" | "disabled" };
        if (!body.id) return cors(json(400, { error: "id is required" }));
        if (body.schedule) {
          const cronError = validateCron(body.schedule);
          if (cronError) return cors(json(400, { error: `invalid cron expression: ${cronError}` }));
        }
        const { id, ...fields } = body;
        const updated = automationStore.update(id, fields);
        if (!updated) return cors(json(404, { error: "automation not found" }));
        automationStore.writeCrontab();
        await controllerAction("restart", "opencode-core", `automation updated: ${updated.name}`);
        return cors(json(200, { ok: true, automation: updated }));
      }

      if (url.pathname === "/admin/automations/delete" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string };
        if (!body.id) return cors(json(400, { error: "id is required" }));
        const removed = automationStore.remove(body.id);
        if (!removed) return cors(json(404, { error: "automation not found" }));
        automationStore.writeCrontab();
        await controllerAction("restart", "opencode-core", "automation deleted");
        return cors(json(200, { ok: true, deleted: body.id }));
      }

      if (url.pathname === "/admin/automations/trigger" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string };
        if (!body.id) return cors(json(400, { error: "id is required" }));
        const job = automationStore.get(body.id);
        if (!job) return cors(json(404, { error: "automation not found" }));
        // Fire directly against opencode-core without waiting for cron
        fetch(`${OPENCODE_CORE_URL}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            message: job.prompt,
            session_id: `cron-${job.id}`,
            user_id: "cron-scheduler",
            metadata: { source: "automation", automationId: job.id, automationName: job.name },
          }),
          signal: AbortSignal.timeout(120_000),
        }).catch(() => {});
        return cors(json(200, { ok: true, triggered: job.id }));
      }

      // ── Providers ─────────────────────────────────────────────
      if (url.pathname === "/admin/providers" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const providers = providerStore.listProviders().map((p) => ({
          ...p,
          apiKey: p.apiKey ? "••••••" : "",
        }));
        const state = providerStore.getState();
        return cors(json(200, { providers, assignments: state.assignments }));
      }

      if (url.pathname === "/admin/providers" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { name?: string; url?: string; apiKey?: string };
        if (!body.name) return cors(json(400, { error: "name is required" }));
        const provider = providerStore.addProvider({
          name: body.name,
          url: body.url ?? "",
          apiKey: body.apiKey ?? "",
        });
        return cors(json(201, { ok: true, provider: { ...provider, apiKey: provider.apiKey ? "••••••" : "" } }));
      }

      if (url.pathname === "/admin/providers/update" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string; name?: string; url?: string; apiKey?: string };
        if (!body.id) return cors(json(400, { error: "id is required" }));
        const { id, ...fields } = body;
        const updated = providerStore.updateProvider(id, fields);
        if (!updated) return cors(json(404, { error: "provider not found" }));
        return cors(json(200, { ok: true, provider: { ...updated, apiKey: updated.apiKey ? "••••••" : "" } }));
      }

      if (url.pathname === "/admin/providers/delete" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string };
        if (!body.id) return cors(json(400, { error: "id is required" }));
        // Capture which roles used this provider before removal
        const stateBefore = providerStore.getState();
        const affectedRoles = Object.entries(stateBefore.assignments)
          .filter(([, assignment]) => assignment.providerId === body.id)
          .map(([role]) => role);
        const removed = providerStore.removeProvider(body.id);
        if (!removed) return cors(json(404, { error: "provider not found" }));
        // Restart services that depended on the deleted provider
        for (const role of affectedRoles) {
          if (role === "small" || role === "openmemory") {
            await controllerAction("restart", "opencode-core", `provider deleted: ${role} assignment cleared`);
          }
          if (role === "openmemory") {
            await controllerAction("restart", "openmemory", `provider deleted: openmemory assignment cleared`);
          }
        }
        return cors(json(200, { ok: true, deleted: body.id }));
      }

      if (url.pathname === "/admin/providers/models" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { providerId?: string };
        if (!body.providerId) return cors(json(400, { error: "providerId is required" }));
        const provider = providerStore.getProvider(body.providerId);
        if (!provider) return cors(json(404, { error: "provider not found" }));
        try {
          const models = await fetchModelsFromProvider(provider.url, provider.apiKey);
          return cors(json(200, { ok: true, models }));
        } catch (e) {
          return cors(json(502, { error: "failed to fetch models", message: e instanceof Error ? e.message : String(e) }));
        }
      }

      if (url.pathname === "/admin/providers/assign" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { role?: string; providerId?: string; modelId?: string };
        if (!body.role || !body.providerId || !body.modelId) return cors(json(400, { error: "role, providerId, and modelId are required" }));
        if (body.role !== "small" && body.role !== "openmemory") return cors(json(400, { error: "role must be 'small' or 'openmemory'" }));
        const provider = providerStore.getProvider(body.providerId);
        if (!provider) return cors(json(404, { error: "provider not found" }));
        const state = providerStore.assignModel(body.role as ModelAssignment, body.providerId, body.modelId);
        applyProviderAssignment(body.role as ModelAssignment, provider.url, provider.apiKey, body.modelId);
        await controllerAction("restart", "opencode-core", `provider assignment: ${body.role}=${body.modelId}`);
        return cors(json(200, { ok: true, assignments: state.assignments }));
      }

      // ── Config editor ─────────────────────────────────────────────
      if (url.pathname === "/admin/config" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        ensureOpencodeConfigPath();
        return cors(new Response(readFileSync(OPENCODE_CONFIG_PATH, "utf8"), { headers: { "content-type": "text/plain" } }));
      }

      if (url.pathname === "/admin/config" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { config: string; restart?: boolean };
        const parsed = parseJsonc(body.config);
        if (typeof parsed !== "object") return cors(json(400, { error: "The configuration file has a syntax error" }));
        const permissions = (parsed as Record<string, unknown>).permission as Record<string, string> | undefined;
        if (permissions && Object.values(permissions).some((v) => v === "allow")) return cors(json(400, { error: "This change would weaken security protections and was blocked" }));
        ensureOpencodeConfigPath();
        const backup = snapshotFile(OPENCODE_CONFIG_PATH);
        writeFileSync(OPENCODE_CONFIG_PATH, body.config, "utf8");
        if (body.restart ?? true) await controllerAction("restart", "opencode-core", "config update");
        return cors(json(200, { ok: true, backup }));
      }

      // ── Static UI (SvelteKit build output) ───────────────────────
      if (req.method === "GET") {
        // Redirect root to /admin/ for direct access (without Caddy)
        if (url.pathname === "/") {
          return cors(new Response(null, {
            status: 302,
            headers: { location: "/admin/" }
          }));
        }

        // Resolve the file path from the request URL.
        // Caddy strips /admin prefix, so the server receives paths like /_app/..., /logo.png, etc.
        // Direct access may include /admin/ prefix, which we strip for file resolution.
        let filePath = url.pathname;
        if (filePath.startsWith("/admin/")) filePath = filePath.slice("/admin".length);
        else if (filePath === "/admin") filePath = "/";

        // Try to serve a static file from the UI build directory
        const resolved = join(UI_DIR, filePath);
        // Prevent path traversal
        if (resolved.startsWith(UI_DIR) && existsSync(resolved)) {
          try {
            const stat = statSync(resolved);
            if (stat.isFile()) {
              const ext = extname(resolved).toLowerCase();
              const mimeTypes: Record<string, string> = {
                ".html": "text/html",
                ".js": "application/javascript",
                ".css": "text/css",
                ".json": "application/json",
                ".png": "image/png",
                ".svg": "image/svg+xml",
                ".ico": "image/x-icon",
                ".woff": "font/woff",
                ".woff2": "font/woff2",
                ".webp": "image/webp",
                ".webmanifest": "application/manifest+json",
              };
              const contentType = mimeTypes[ext] ?? "application/octet-stream";
              const headers: Record<string, string> = { "content-type": contentType };
              // Cache immutable hashed assets indefinitely
              if (filePath.includes("/_app/immutable/")) {
                headers["cache-control"] = "public, max-age=31536000, immutable";
              }
              return cors(new Response(Bun.file(resolved), { headers }));
            }
          } catch { /* fall through to SPA fallback */ }
        }

        // SPA fallback: serve index.html for all unmatched GET requests
        const indexPath = join(UI_DIR, "index.html");
        if (existsSync(indexPath)) {
          return cors(new Response(Bun.file(indexPath), {
            headers: { "content-type": "text/html" }
          }));
        }
      }

      return cors(json(404, { error: "not_found" }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNotFound = message.includes("not found") || message.includes("missing");
      const status = isNotFound ? 404 : 500;
      const errorCode = isNotFound ? "not_found" : "internal_error";
      console.error(`[${requestId}] ${errorCode}:`, error);
      const clientMessage = status === 500 ? "An internal error occurred" : message;
      return cors(json(status, { error: errorCode, message: clientMessage, requestId }));
    }
  }
});

console.log(JSON.stringify({ kind: "startup", service: "admin", port: server.port }));
if (ADMIN_TOKEN === "change-me-admin-token") {
  console.warn("[WARN] Using default admin token. Set ADMIN_TOKEN environment variable for security.");
}
