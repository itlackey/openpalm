import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { SetupManager } from "@openpalm/lib/admin/setup-manager.ts";
import { ensureCronDirs, syncAutomations, triggerAutomation } from "@openpalm/lib/admin/automations.ts";
import { getLatestRun } from "@openpalm/lib/admin/automation-history.ts";
import { validateCron } from "@openpalm/lib/admin/cron.ts";
import { parseRuntimeEnvContent, sanitizeEnvScalar, setRuntimeBindScopeContent, updateRuntimeEnvContent } from "@openpalm/lib/admin/runtime-env.ts";
import { StackManager, CoreSecretRequirements } from "@openpalm/lib/admin/stack-manager.ts";
import { isBuiltInChannel, parseStackSpec } from "@openpalm/lib/admin/stack-spec.ts";
import { allowedServiceSet, composeAction } from "@openpalm/lib/admin/compose-runner.ts";
import { applyStack } from "@openpalm/lib/admin/stack-apply-engine.ts";
import { parseJsonc, stringifyPretty } from "@openpalm/lib/admin/jsonc.ts";

const PORT = Number(Bun.env.PORT ?? 8100);
const ADMIN_TOKEN = Bun.env.ADMIN_TOKEN ?? "change-me-admin-token";
const DATA_ROOT = Bun.env.OPENPALM_DATA_ROOT ?? "/data";
const CONFIG_ROOT = Bun.env.OPENPALM_CONFIG_ROOT ?? "/config";
const STATE_ROOT = Bun.env.OPENPALM_STATE_ROOT ?? "/state";

const OPENCODE_CONFIG_PATH = Bun.env.OPENCODE_CONFIG_PATH ?? `${DATA_ROOT}/assistant/.config/opencode/opencode.json`;
const DATA_DIR = Bun.env.DATA_DIR ?? `${DATA_ROOT}/admin`;
const GATEWAY_URL = Bun.env.GATEWAY_URL ?? "http://gateway:8080";
const CADDYFILE_PATH = Bun.env.CADDYFILE_PATH ?? `${STATE_ROOT}/rendered/caddy/Caddyfile`;
const CADDY_ROUTES_DIR = Bun.env.CADDY_ROUTES_DIR ?? `${STATE_ROOT}/rendered/caddy/snippets`;
const OPENCODE_CORE_URL = Bun.env.OPENCODE_CORE_URL ?? "http://assistant:4096";
const OPENMEMORY_URL = Bun.env.OPENMEMORY_URL ?? "http://openmemory:8765";
const RUNTIME_ENV_PATH = Bun.env.RUNTIME_ENV_PATH ?? `${STATE_ROOT}/.env`;
const SECRETS_ENV_PATH = Bun.env.SECRETS_ENV_PATH ?? `${CONFIG_ROOT}/secrets.env`;
const STACK_SPEC_PATH = Bun.env.STACK_SPEC_PATH ?? `${CONFIG_ROOT}/stack-spec.json`;
const COMPOSE_FILE_PATH = Bun.env.COMPOSE_FILE_PATH ?? `${STATE_ROOT}/rendered/docker-compose.yml`;
const UI_DIR = Bun.env.UI_DIR ?? "/app/ui";

function allChannelServiceNames(): string[] {
  return stackManager.listChannelNames().map((name) => `channel-${name}`);
}

function knownServices(): Set<string> {
  const base = allowedServiceSet();
  for (const svc of allChannelServiceNames()) base.add(svc);
  return base;
}

const setupManager = new SetupManager(DATA_DIR);
const stackManager = new StackManager({
  stateRootPath: STATE_ROOT,
  caddyfilePath: CADDYFILE_PATH,
  caddyJsonPath: Bun.env.CADDY_JSON_PATH ?? `${STATE_ROOT}/rendered/caddy/caddy.json`,
  caddyRoutesDir: CADDY_ROUTES_DIR,
  secretsEnvPath: SECRETS_ENV_PATH,
  stackSpecPath: STACK_SPEC_PATH,
  gatewayEnvPath: Bun.env.GATEWAY_ENV_PATH ?? `${STATE_ROOT}/gateway/.env`,
  openmemoryEnvPath: Bun.env.OPENMEMORY_ENV_PATH ?? `${STATE_ROOT}/openmemory/.env`,
  postgresEnvPath: Bun.env.POSTGRES_ENV_PATH ?? `${STATE_ROOT}/postgres/.env`,
  qdrantEnvPath: Bun.env.QDRANT_ENV_PATH ?? `${STATE_ROOT}/qdrant/.env`,
  assistantEnvPath: Bun.env.ASSISTANT_ENV_PATH ?? `${STATE_ROOT}/assistant/.env`,
  composeFilePath: COMPOSE_FILE_PATH,
});

ensureCronDirs();
syncAutomations(stackManager.listAutomations());

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function errorJson(status: number, error: string, details?: unknown) {
  const payload: Record<string, unknown> = { error };
  if (details !== undefined) payload.details = details;
  return json(status, payload);
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

function updateRuntimeEnv(entries: Record<string, string | undefined>) {
  const current = existsSync(RUNTIME_ENV_PATH) ? readFileSync(RUNTIME_ENV_PATH, "utf8") : "";
  const next = updateRuntimeEnvContent(current, entries);
  writeFileSync(RUNTIME_ENV_PATH, next, "utf8");
}

function setRuntimeBindScope(scope: "host" | "lan" | "public") {
  const current = existsSync(RUNTIME_ENV_PATH) ? readFileSync(RUNTIME_ENV_PATH, "utf8") : "";
  const next = setRuntimeBindScopeContent(current, scope);
  writeFileSync(RUNTIME_ENV_PATH, next, "utf8");
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

function ensureOpencodeConfigPath() {
  if (existsSync(OPENCODE_CONFIG_PATH)) return;
  mkdirSync(dirname(OPENCODE_CONFIG_PATH), { recursive: true });
  writeFileSync(OPENCODE_CONFIG_PATH, "{\n  \"plugin\": []\n}\n", "utf8");
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
  writeFileSync(OPENCODE_CONFIG_PATH, stringifyPretty(doc), "utf8");
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

function normalizeSelectedChannels(value: unknown) {
  if (!Array.isArray(value)) return [];
  const validServices = new Set(allChannelServiceNames());
  const selected: string[] = [];
  for (const service of value) {
    if (typeof service !== "string") continue;
    if (!validServices.has(service)) continue;
    if (selected.includes(service)) continue;
    selected.push(service);
  }
  return selected;
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

      // ── Meta (display names + channel fields for wizard) ──────────
      if (url.pathname === "/admin/meta" && req.method === "GET") {
        return cors(json(200, {
          serviceNames: {
            gateway: { label: "Message Router", description: "Routes messages between channels and your assistant" },
            assistant: { label: "AI Assistant", description: "The core assistant engine" },
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
        const validSteps = ["welcome", "accessScope", "serviceInstances", "healthCheck", "security", "channels"];
        if (!validSteps.includes(body.step)) return cors(json(400, { error: "invalid step" }));
        const state = setupManager.completeStep(body.step as "welcome" | "accessScope" | "serviceInstances" | "healthCheck" | "security" | "channels");
        return cors(json(200, { ok: true, state }));
      }

      if (url.pathname === "/admin/setup/access-scope" && req.method === "POST") {
        const body = (await req.json()) as { scope: "host" | "lan" | "public" };
        if (!["host", "lan", "public"].includes(body.scope)) return cors(json(400, { error: "invalid scope" }));
        const current = setupManager.getState();
        if (current.completed && !auth(req)) return cors(json(401, { error: "admin token required" }));
        stackManager.setAccessScope(body.scope);
        setRuntimeBindScope(body.scope);
        await Promise.all([
          composeAction("up", "caddy"),
          composeAction("up", "openmemory"),
          composeAction("up", "assistant"),
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
        const openmemory = sanitizeEnvScalar(body.openmemory);
        const psql = sanitizeEnvScalar(body.psql);
        const qdrant = sanitizeEnvScalar(body.qdrant);
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
        if (openaiApiKey.length > 0) secretEntries.OPENAI_API_KEY = openaiApiKey;
        if (anthropicApiKey.length > 0) secretEntries.ANTHROPIC_API_KEY = anthropicApiKey;
        if (smallModelApiKey.length > 0) secretEntries.OPENPALM_SMALL_MODEL_API_KEY = smallModelApiKey;
        updateSecretsEnv(secretEntries);
        const state = setupManager.setServiceInstances({ openmemory, psql, qdrant });
        if (smallModelId) {
          setupManager.setSmallModel({ endpoint: smallModelEndpoint, modelId: smallModelId });
          applySmallModelToOpencodeConfig(smallModelEndpoint, smallModelId);
        }
        return cors(json(200, { ok: true, state, openmemoryProvider: getConfiguredOpenmemoryProvider(), smallModelProvider: getConfiguredSmallModel() }));
      }

      if (url.pathname === "/admin/setup/channels" && req.method === "POST") {
        const body = (await req.json()) as { channels?: unknown; channelConfigs?: Record<string, Record<string, string>> };
        const current = setupManager.getState();
        if (current.completed && !auth(req)) return cors(json(401, { error: "admin token required" }));
        const channels = normalizeSelectedChannels(body.channels);
        updateRuntimeEnv({ OPENPALM_ENABLED_CHANNELS: channels.length ? channels.join(",") : undefined });

        // Save channel-specific config values from the wizard
        if (body.channelConfigs && typeof body.channelConfigs === "object") {
          for (const [service, values] of Object.entries(body.channelConfigs)) {
            const channelName = service.replace("channel-", "");
            if (stackManager.listChannelNames().includes(channelName) && values && typeof values === "object") {
              stackManager.setChannelConfig(channelName, values);
            }
          }
        }

        // Enable/disable channels in the stack spec
        const spec = stackManager.getSpec();
        for (const channelName of stackManager.listChannelNames()) {
          const service = `channel-${channelName}`;
          spec.channels[channelName].enabled = channels.includes(service);
        }
        stackManager.setSpec(spec);

        const state = setupManager.setEnabledChannels(channels);
        return cors(json(200, { ok: true, state }));
      }

      if (url.pathname === "/admin/setup/health-check" && req.method === "GET") {
        const serviceInstances = getConfiguredServiceInstances();
        const openmemoryBaseUrl = serviceInstances.openmemory || OPENMEMORY_URL;
        const [gateway, assistant, openmemory] = await Promise.all([
          checkServiceHealth(`${GATEWAY_URL}/health`),
          checkServiceHealth(`${OPENCODE_CORE_URL}/`, false),
          checkServiceHealth(`${openmemoryBaseUrl}/api/v1/config/`)
        ]);
        return cors(json(200, {
          services: { gateway, assistant, openmemory, admin: { ok: true, time: new Date().toISOString() } },
          serviceInstances
        }));
      }

      // ── Stack spec (for admin editor) ─────────────────────────────
      if (url.pathname === "/admin/stack/spec" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const spec = stackManager.getSpec();
        return cors(json(200, { ok: true, spec }));
      }

      if (url.pathname === "/admin/stack/spec" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { spec?: unknown };
        if (!body.spec) return cors(json(400, { error: "spec is required" }));
        const parsed = parseStackSpec(body.spec);
        const secretErrors = stackManager.validateReferencedSecrets(parsed);
        if (secretErrors.length > 0) {
          return cors(errorJson(400, "secret_reference_validation_failed", secretErrors));
        }
        const spec = stackManager.setSpec(body.spec);
        return cors(json(200, { ok: true, spec }));
      }

      if (url.pathname === "/admin/stack/apply" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        try {
          const result = await applyStack(stackManager);
          syncAutomations(stackManager.listAutomations());
          return cors(json(200, result));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith("secret_validation_failed:")) {
            return cors(errorJson(400, "secret_reference_validation_failed", message.replace("secret_validation_failed:", "").split(",")));
          }
          return cors(errorJson(500, "stack_apply_failed", message));
        }
      }

      // ── Secrets (for admin editor) ────────────────────────────────
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
          if (message === "invalid_secret_name") return cors(errorJson(400, message));
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
          if (message === "invalid_secret_name" || message === "secret_in_use") return cors(errorJson(400, message));
          throw error;
        }
      }

      if (url.pathname === "/admin/secrets/raw" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const content = existsSync(SECRETS_ENV_PATH) ? readFileSync(SECRETS_ENV_PATH, "utf8") : "";
        return cors(new Response(content, { headers: { "content-type": "text/plain" } }));
      }

      if (url.pathname === "/admin/secrets/raw" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { content?: string };
        if (typeof body.content !== "string") return cors(json(400, { error: "content is required" }));
        writeFileSync(SECRETS_ENV_PATH, body.content, "utf8");
        stackManager.renderArtifacts();
        return cors(json(200, { ok: true }));
      }

      // ── Container management (minimal) ────────────────────────────
      if (url.pathname === "/admin/containers/restart" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string };
        if (!body.service || !knownServices().has(body.service)) return cors(json(400, { error: "unknown service name" }));
        await composeAction("restart", body.service);
        return cors(json(200, { ok: true, action: "restart", service: body.service }));
      }

      if (url.pathname === "/admin/containers/up" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { service: string };
        if (!body.service || !knownServices().has(body.service)) return cors(json(400, { error: "unknown service name" }));
        await composeAction("up", body.service);
        return cors(json(200, { ok: true, action: "up", service: body.service }));
      }

      // ── Automations ───────────────────────────────────────────────
      if (url.pathname === "/admin/automations" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const automations = stackManager.listAutomations().map((automation) => ({
          ...automation,
          lastRun: getLatestRun(automation.id),
        }));
        return cors(json(200, { automations }));
      }

      if (url.pathname === "/admin/automations" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { name?: string; schedule?: string; script?: string; enabled?: boolean };
        if (!body.name || !body.schedule || !body.script) {
          return cors(json(400, { error: "name, schedule, and script are required" }));
        }
        const cronError = validateCron(body.schedule);
        if (cronError) return cors(json(400, { error: `invalid cron expression: ${cronError}` }));
        const automation = stackManager.upsertAutomation({
          id: randomUUID(),
          name: body.name,
          schedule: body.schedule,
          script: body.script,
          enabled: body.enabled ?? true,
        });
        syncAutomations(stackManager.listAutomations());
        return cors(json(201, { ok: true, automation }));
      }

      if (url.pathname === "/admin/automations/update" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string; name?: string; schedule?: string; script?: string; enabled?: boolean };
        if (!body.id) return cors(json(400, { error: "id is required" }));
        const existing = stackManager.getAutomation(body.id);
        if (!existing) return cors(json(404, { error: "automation not found" }));
        const updated = { ...existing, ...body, id: existing.id };
        const cronError = validateCron(updated.schedule);
        if (cronError) return cors(json(400, { error: `invalid cron expression: ${cronError}` }));
        const automation = stackManager.upsertAutomation(updated);
        syncAutomations(stackManager.listAutomations());
        return cors(json(200, { ok: true, automation }));
      }

      if (url.pathname === "/admin/automations/delete" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string };
        if (!body.id) return cors(json(400, { error: "id is required" }));
        const deleted = stackManager.deleteAutomation(body.id);
        if (!deleted) return cors(json(404, { error: "automation not found" }));
        syncAutomations(stackManager.listAutomations());
        return cors(json(200, { ok: true, deleted: body.id }));
      }

      if (url.pathname === "/admin/automations/trigger" && req.method === "POST") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const body = (await req.json()) as { id?: string };
        if (!body.id) return cors(json(400, { error: "id is required" }));
        if (!stackManager.getAutomation(body.id)) return cors(json(404, { error: "automation not found" }));
        const result = await triggerAutomation(body.id);
        return cors(json(200, { triggered: body.id, ...result }));
      }

      // ── Channels (for wizard) ─────────────────────────────────────
      if (url.pathname === "/admin/channels" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        const spec = stackManager.getSpec();
        const channelNames = stackManager.listChannelNames();
        return cors(json(200, {
          channels: channelNames.map((channelName) => ({
            service: `channel-${channelName}`,
            label: channelName.charAt(0).toUpperCase() + channelName.slice(1),
            builtIn: isBuiltInChannel(channelName),
            access: stackManager.getChannelAccess(channelName),
            config: { ...spec.channels[channelName].config },
            channelSpec: spec.channels[channelName],
          }))
        }));
      }

      // ── Installed plugins (read-only list) ────────────────────────
      if (url.pathname === "/admin/installed" && req.method === "GET") {
        if (!auth(req)) return cors(json(401, { error: "admin token required" }));
        ensureOpencodeConfigPath();
        const raw = readFileSync(OPENCODE_CONFIG_PATH, "utf8");
        const doc = parseJsonc(raw) as { plugin?: string[] };
        const plugins = Array.isArray(doc.plugin) ? doc.plugin.filter((value): value is string => typeof value === "string") : [];
        return cors(json(200, { plugins }));
      }

      // ── Static UI ─────────────────────────────────────────────────
      if (url.pathname.startsWith("/admin/opencode")) {
        const subpath = url.pathname.slice("/admin/opencode".length) || "/";
        const target = `${OPENCODE_CORE_URL}${subpath}${url.search}`;
        try {
          const proxyResp = await fetch(target, { signal: AbortSignal.timeout(5000) });
          return new Response(proxyResp.body, { status: proxyResp.status, headers: proxyResp.headers });
        } catch {
          return cors(json(502, { error: "assistant_unavailable" }));
        }
      }

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

      return cors(errorJson(404, "not_found"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isNotFound = message.includes("not found") || message.includes("missing");
      const status = isNotFound ? 404 : 500;
      const errorCode = isNotFound ? "not_found" : "internal_error";
      console.error(`[${requestId}] ${errorCode}:`, error);
      const clientMessage = status === 500 ? "An internal error occurred" : message;
      return cors(errorJson(status, errorCode, { message: clientMessage, requestId }));
    }
  }
});

console.log(JSON.stringify({ kind: "startup", service: "admin", port: server.port }));
if (ADMIN_TOKEN === "change-me-admin-token") {
  console.warn("[WARN] Using default admin token. Set ADMIN_TOKEN environment variable for security.");
}
