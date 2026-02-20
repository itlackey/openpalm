import { readFileSync, existsSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { parseJsonc, stringifyPretty } from "./jsonc.ts";
import { searchGallery, getGalleryItem, listGalleryCategories, searchNpm, getRiskBadge, searchPublicRegistry, fetchPublicRegistry, getPublicRegistryItem } from "./gallery.ts";
import { SetupManager } from "./setup.ts";
import { AutomationStore, validateCron } from "./automation-store.ts";
import { ProviderStore } from "./provider-store.ts";
import { parseRuntimeEnvContent, sanitizeEnvScalar, setRuntimeBindScopeContent, updateRuntimeEnvContent } from "./runtime-env.ts";
import { StackManager, type ChannelName as StackManagerChannelName, CoreSecretRequirements } from "./lib/stack-manager.ts";
import { composeAction, composeList, composeLogs, composePull, composeServiceNames } from "./lib/compose-runner.ts";
import { applyStack, previewComposeOperations } from "./lib/stack-apply-engine.ts";
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
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const CADDYFILE_PATH = Bun.env.CADDYFILE_PATH ?? "/app/config/Caddyfile";
const CADDY_ROUTES_DIR = Bun.env.CADDY_ROUTES_DIR ?? "/app/config/caddy/routes";
const CHANNEL_ENV_DIR = Bun.env.CHANNEL_ENV_DIR ?? "/app/channel-env";
const OPENCODE_CORE_URL = Bun.env.OPENCODE_CORE_URL ?? "http://opencode-core:4096";
const OPENMEMORY_URL = Bun.env.OPENMEMORY_URL ?? "http://openmemory:8765";
const OPENCODE_CORE_CONFIG_DIR = Bun.env.OPENCODE_CORE_CONFIG_DIR ?? "/app/config/opencode-core";
const CRON_DIR = Bun.env.CRON_DIR ?? "/app/config-root/cron";
const RUNTIME_ENV_PATH = Bun.env.RUNTIME_ENV_PATH ?? "/workspace/.env";
const SECRETS_ENV_PATH = Bun.env.SECRETS_ENV_PATH ?? "/app/config-root/secrets.env";
const STACK_SPEC_PATH = Bun.env.STACK_SPEC_PATH ?? "/app/config-root/stack-spec.json";
const CHANNEL_SECRET_DIR = Bun.env.CHANNEL_SECRET_DIR ?? "/app/config-root/secrets/channels";
const GATEWAY_CHANNEL_SECRETS_PATH = Bun.env.GATEWAY_CHANNEL_SECRETS_PATH ?? "/app/config-root/secrets/gateway/channels.env";
const COMPOSE_FILE_PATH = Bun.env.COMPOSE_FILE_PATH ?? "/workspace/docker-compose.yml";
const UI_DIR = Bun.env.UI_DIR ?? "/app/ui";
const CHANNEL_SERVICES = ["channel-chat", "channel-discord", "channel-voice", "channel-telegram"] as const;
const CHANNEL_SERVICE_SET = new Set<string>(CHANNEL_SERVICES);
const KNOWN_SERVICES = new Set<string>([
  "gateway", "opencode-core", "openmemory", "openmemory-ui",
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
const stackManager = new StackManager({
  caddyfilePath: CADDYFILE_PATH,
  caddyRoutesDir: CADDY_ROUTES_DIR,
  secretsEnvPath: SECRETS_ENV_PATH,
  stackSpecPath: STACK_SPEC_PATH,
  channelSecretDir: CHANNEL_SECRET_DIR,
  gatewayChannelSecretsPath: GATEWAY_CHANNEL_SECRETS_PATH,
  gatewayRuntimeSecretsPath: Bun.env.GATEWAY_RUNTIME_SECRETS_PATH ?? "/app/config-root/secrets/gateway/gateway.env",
  openmemorySecretsPath: Bun.env.OPENMEMORY_SECRETS_PATH ?? "/app/config-root/secrets/openmemory/openmemory.env",
  postgresSecretsPath: Bun.env.POSTGRES_SECRETS_PATH ?? "/app/config-root/secrets/db/postgres.env",
  opencodeProviderSecretsPath: Bun.env.OPENCODE_PROVIDER_SECRETS_PATH ?? "/app/config-root/secrets/opencode/providers.env",
  channelEnvDir: CHANNEL_ENV_DIR,
  composeFilePath: COMPOSE_FILE_PATH,
  opencodeConfigPath: OPENCODE_CONFIG_PATH,
});

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



type ChannelName = StackManagerChannelName;

function detectChannelAccess(channel: ChannelName): "lan" | "public" {
  return stackManager.getChannelAccess(channel);
}

function setChannelAccess(channel: ChannelName, access: "lan" | "public") {
  stackManager.setChannelAccess(channel, access);
}

function setAccessScope(scope: "host" | "lan") {
  stackManager.setAccessScope(scope);
}

function channelNameFromService(service: string): ChannelName {
  return service.replace("channel-", "") as ChannelName;
}

function readChannelConfig(service: string) {
  return stackManager.getChannelConfig(channelNameFromService(service));
}

function writeChannelConfig(service: string, values: Record<string, string>) {
  stackManager.setChannelConfig(channelNameFromService(service), values);
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
          },
          requiredCoreSecrets: CoreSecretRequirements
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
          composeAction("up", "caddy"),
          composeAction("up", "openmemory"),
          composeAction("up", "opencode-core"),
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

      // ── Stack spec + generator (phase 1 scaffolding) ─────────────
      if (url.pathname === "/admin/stack/spec" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const spec = stackManager.getSpec();
        return cors(json(200, { ok: true, spec }));
      }

      if (url.pathname === "/admin/stack/spec" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { spec?: unknown };
        if (!body.spec) return cors(json(400, { error: "spec is required" }));
        const spec = stackManager.setSpec(body.spec);
        return cors(json(200, { ok: true, spec }));
      }

      if (url.pathname === "/admin/stack/render" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const generated = stackManager.renderPreview();
        return cors(json(200, { ok: true, generated }));
      }

      if (url.pathname === "/admin/stack/apply" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { apply?: boolean };
        try {
          const result = await applyStack(stackManager, { apply: body.apply ?? true });
          return cors(json(200, result));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("secret_validation_failed:")) {
            return cors(json(400, { error: "secret_validation_failed", details: message.replace("secret_validation_failed:", "").split(",") }));
          }
          if (message.startsWith("compose_validation_failed:")) {
            return cors(json(400, { error: "compose_validation_failed", details: message.replace("compose_validation_failed:", "") }));
          }
          return cors(json(500, { error: "stack_apply_failed", details: message }));
        }
      }

      if (url.pathname === "/admin/stack/impact" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const result = await applyStack(stackManager, { apply: false });
        return cors(json(200, { ok: true, impact: result.impact, warnings: result.warnings }));
      }

      if (url.pathname === "/admin/compose/capabilities" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const preview = await previewComposeOperations();
        return cors(json(200, { ok: true, ...preview }));
      }

      if (url.pathname === "/admin/secrets/map" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const spec = stackManager.getSpec();
        return cors(json(200, { ok: true, secrets: spec.secrets }));
      }

      if (url.pathname === "/admin/secrets" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        return cors(json(200, { ok: true, ...stackManager.listSecretManagerState() }));
      }

      if (url.pathname === "/admin/secrets" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { name?: string; value?: string };
        try {
          const name = stackManager.upsertSecret(body.name, body.value);
          return cors(json(200, { ok: true, name }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === "invalid_secret_name") return cors(json(400, { error: message }));
          throw error;
        }
      }

      if (url.pathname === "/admin/secrets/delete" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { name?: string };
        try {
          const deleted = stackManager.deleteSecret(body.name);
          return cors(json(200, { ok: true, deleted }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === "invalid_secret_name" || message === "secret_in_use") return cors(json(400, { error: message }));
          throw error;
        }
      }

      if (url.pathname === "/admin/secrets/mappings/channel" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { channel?: ChannelName; target?: "gateway" | "channel"; secretName?: string };
        if (!body.channel || !["chat", "discord", "voice", "telegram"].includes(body.channel)) return cors(json(400, { error: "invalid channel" }));
        if (body.target !== "gateway" && body.target !== "channel") return cors(json(400, { error: "invalid target" }));
        try {
          const mapped = stackManager.mapChannelSecret(body.channel, body.target, body.secretName);
          return cors(json(200, { ok: true, ...mapped }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === "invalid_channel" || message === "invalid_target" || message === "invalid_secret_name" || message === "unknown_secret_name") {
            return cors(json(400, { error: message }));
          }
          throw error;
        }
      }

      if (url.pathname === "/admin/connections" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        return cors(json(200, { ok: true, connections: stackManager.listConnections() }));
      }

      if (url.pathname === "/admin/connections" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string; name?: string; type?: string; env?: Record<string, string> };
        try {
          const connection = stackManager.upsertConnection(body);
          return cors(json(200, { ok: true, connection }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            message === "invalid_connection_id" ||
            message === "invalid_connection_name" ||
            message === "invalid_connection_type" ||
            message === "missing_connection_env" ||
            message === "invalid_connection_env_key" ||
            message === "invalid_connection_env_value"
          ) {
            return cors(json(400, { error: message }));
          }
          throw error;
        }
      }

      if (url.pathname === "/admin/connections/delete" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string };
        try {
          const deleted = stackManager.deleteConnection(body.id);
          return cors(json(200, { ok: true, deleted }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message === "invalid_connection_id" || message === "connection_not_found" || message === "connection_in_use") {
            return cors(json(400, { error: message }));
          }
          throw error;
        }
      }

      if (url.pathname === "/admin/channels/shared-secret" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { channel?: ChannelName; secret?: string };
        if (!body.channel || !["chat", "discord", "voice", "telegram"].includes(body.channel)) {
          return cors(json(400, { error: "invalid channel" }));
        }
        const secret = sanitizeEnvScalar(body.secret);
        if (secret.length > 0 && secret.length < 32) return cors(json(400, { error: "secret must be at least 32 characters" }));
        stackManager.setChannelSharedSecret(body.channel, secret);
        return cors(json(200, { ok: true, channel: body.channel }));
      }

      if (url.pathname === "/admin/setup/health-check" && req.method === "GET") {
        const serviceInstances = getConfiguredServiceInstances();
        const openmemoryBaseUrl = serviceInstances.openmemory || OPENMEMORY_URL;
        const [gateway, opencodeCore, openmemory] = await Promise.all([
          checkServiceHealth(`${GATEWAY_URL}/health`),
          checkServiceHealth(`${OPENCODE_CORE_URL}/`, false),
          checkServiceHealth(`${openmemoryBaseUrl}/api/v1/config/`)
        ]);
        return cors(json(200, {
          services: {
            gateway,
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
          const item = getGalleryItem(body.galleryId) ?? await getPublicRegistryItem(body.galleryId);
          if (!item) return cors(json(404, { error: "gallery item not found" }));

          if (item.installAction === "plugin") {
            const result = stackManager.setExtensionInstalled({
              extensionId: item.id,
              type: "plugin",
              enabled: true,
              pluginId: item.installTarget,
            });
            await composeAction("restart", "opencode-core");
            setupManager.addExtension(item.id);
            return cors(json(200, { ok: true, installed: item.id, type: "plugin", result }));
          }

          if (item.installAction === "skill-file") {
            const result = stackManager.setExtensionInstalled({
              extensionId: item.id,
              type: "skill",
              enabled: true,
            });
            setupManager.addExtension(item.id);
            return cors(json(200, { ok: true, installed: item.id, type: "skill", note: "Skill files ship with OpenPalm. Marked as enabled.", result }));
          }

          if (item.installAction === "compose-service") {
            await composeAction("up", item.installTarget);
            setupManager.addExtension(item.id);
            setupManager.addChannel(item.installTarget);
            return cors(json(200, { ok: true, installed: item.id, type: "container", service: item.installTarget }));
          }

          return cors(json(400, { error: "unknown install action" }));
        }

        if (body.pluginId) {
          try {
            const result = stackManager.setExtensionInstalled({
              extensionId: body.pluginId,
              type: "plugin",
              enabled: true,
              pluginId: body.pluginId,
            });
            await composeAction("restart", "opencode-core");
            return cors(json(200, { ok: true, pluginId: body.pluginId, result }));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message === "invalid_plugin_id") return cors(json(400, { error: "invalid plugin id" }));
            throw error;
          }
        }

        return cors(json(400, { error: "galleryId or pluginId required" }));
      }

      if (url.pathname === "/admin/gallery/uninstall" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { galleryId?: string; pluginId?: string };

        if (body.galleryId) {
          const item = getGalleryItem(body.galleryId) ?? await getPublicRegistryItem(body.galleryId);
          if (!item) return cors(json(404, { error: "gallery item not found" }));
          if (item.installAction === "plugin") {
            const result = stackManager.setExtensionInstalled({
              extensionId: item.id,
              type: "plugin",
              enabled: false,
              pluginId: item.installTarget,
            });
            await composeAction("restart", "opencode-core");
            return cors(json(200, { ok: true, uninstalled: item.id, type: "plugin", result }));
          }
          if (item.installAction === "compose-service") {
            await composeAction("down", item.installTarget);
            return cors(json(200, { ok: true, uninstalled: item.id, type: "container", service: item.installTarget }));
          }
          stackManager.setExtensionInstalled({
            extensionId: item.id,
            type: "skill",
            enabled: false,
          });
          return cors(json(200, { ok: true, uninstalled: item.id, type: item.installAction }));
        }

        if (body.pluginId) {
          try {
            const result = stackManager.setExtensionInstalled({
              extensionId: body.pluginId,
              type: "plugin",
              enabled: false,
              pluginId: body.pluginId,
            });
            await composeAction("restart", "opencode-core");
            return cors(json(200, { ok: true, action: "disabled", result }));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message === "invalid_plugin_id") return cors(json(400, { error: "invalid plugin id" }));
            throw error;
          }
        }

        return cors(json(400, { error: "galleryId or pluginId required" }));
      }

      // ── Installed status ──────────────────────────────────────────
      if (url.pathname === "/admin/installed" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const state = setupManager.getState();
        const installed = stackManager.listInstalled();
        return cors(json(200, {
          plugins: installed.plugins,
          extensions: installed.extensions,
          setupState: state
        }));
      }

      // ── Container management ──────────────────────────────────────
      if (url.pathname === "/admin/containers/list" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const result = await composeList();
        if (!result.ok) return cors(json(500, { ok: false, error: result.stderr }));
        return cors(json(200, { ok: true, containers: result.stdout }));
      }

      if (url.pathname === "/admin/containers/up" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string };
        if (!body.service || !KNOWN_SERVICES.has(body.service)) return cors(json(400, { error: "unknown service name" }));
        await composeAction("up", body.service);
        return cors(json(200, { ok: true, action: "up", service: body.service }));
      }

      if (url.pathname === "/admin/containers/down" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string };
        if (!body.service || !KNOWN_SERVICES.has(body.service)) return cors(json(400, { error: "unknown service name" }));
        await composeAction("down", body.service);
        return cors(json(200, { ok: true, action: "down", service: body.service }));
      }

      if (url.pathname === "/admin/containers/restart" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string };
        if (!body.service || !KNOWN_SERVICES.has(body.service)) return cors(json(400, { error: "unknown service name" }));
        await composeAction("restart", body.service);
        return cors(json(200, { ok: true, action: "restart", service: body.service }));
      }

      if (url.pathname === "/admin/channels" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const spec = stackManager.getSpec();
        return cors(json(200, {
          secretOptions: spec.secrets.available,
          channels: CHANNEL_SERVICES.map((service) => {
            const channelName = service.replace("channel-", "") as ChannelName;
            return {
              service,
              label: channelName.charAt(0).toUpperCase() + channelName.slice(1),
              access: detectChannelAccess(channelName),
              config: readChannelConfig(service),
              secretMappings: {
                ...stackManager.getChannelSecretMappings(channelName),
              },
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
        await composeAction("restart", "caddy");
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
        if (body.restart ?? true) await composeAction("restart", body.service);
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
        await composeAction("restart", "opencode-core");
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
        await composeAction("restart", "opencode-core");
        return cors(json(200, { ok: true, automation: updated }));
      }

      if (url.pathname === "/admin/automations/delete" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string };
        if (!body.id) return cors(json(400, { error: "id is required" }));
        const removed = automationStore.remove(body.id);
        if (!removed) return cors(json(404, { error: "automation not found" }));
        automationStore.writeCrontab();
        await composeAction("restart", "opencode-core");
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
            await composeAction("restart", "opencode-core");
          }
          if (role === "openmemory") {
            await composeAction("restart", "openmemory");
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
        await composeAction("restart", "opencode-core");
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
        if (body.restart ?? true) await composeAction("restart", "opencode-core");
        return cors(json(200, { ok: true, backup }));
      }

      // ── Static UI ─────────────────────────────────────────────────
      if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
        const indexPath = `${UI_DIR}/index.html`;
        if (!existsSync(indexPath)) return cors(json(500, { error: "admin ui missing" }));
        return new Response(Bun.file(indexPath), { headers: { "content-type": "text/html" } });
      }

      if (url.pathname === "/setup-ui.js" && req.method === "GET") {
        const jsPath = `${UI_DIR}/setup-ui.js`;
        if (!existsSync(jsPath)) return cors(json(404, { error: "setup ui missing" }));
        return new Response(Bun.file(jsPath), { headers: { "content-type": "application/javascript" } });
      }

      if (url.pathname === "/logo.png" && req.method === "GET") {
        const logoPath = `${UI_DIR}/logo.png`;
        if (!existsSync(logoPath)) return cors(json(404, { error: "logo missing" }));
        return new Response(Bun.file(logoPath), { headers: { "content-type": "image/png" } });
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
