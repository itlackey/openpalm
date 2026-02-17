import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "./memory.ts";
import { canRemember, classifyTool, validateToolRequest } from "./policy.ts";
import { classifyPluginRisk, preflightPlugin, updatePluginListAtomically, validatePluginIdentifier } from "./extensions.ts";
import { AuditLog } from "./audit.ts";
import { classifyBundleRisk, collectBundleMetrics, prepareBundleRegistry, registerBundleState, snapshotFile, validateBundle } from "./change-manager.ts";
import { parseJsonc, stringifyPretty } from "./jsonc.ts";
import { verifyReplayProtection, verifySignature } from "./channel-security.ts";
import { allowRequest } from "./rate-limit.ts";
import { ExtensionQueue } from "./admin-store.ts";
import type { ChannelMessage, MessageRequest } from "./types.ts";

const PORT = Number(Bun.env.PORT ?? 8080);
const ADMIN_TOKEN = Bun.env.ADMIN_TOKEN ?? "change-me-admin-token";
const ADMIN_STEP_UP_TOKEN = Bun.env.ADMIN_STEP_UP_TOKEN ?? "change-me-step-up";
const OPENCODE_CONFIG_PATH = Bun.env.OPENCODE_CONFIG_PATH ?? "/app/config/opencode.jsonc";
const CHANGE_BUNDLE_DIR = Bun.env.CHANGE_BUNDLE_DIR ?? "/app/data/bundles";
const CHANGE_STATE_DIR = Bun.env.CHANGE_STATE_DIR ?? "/app/data/change-states";
const EXT_REQUESTS_PATH = Bun.env.EXT_REQUESTS_PATH ?? "/app/data/extension-requests.json";
const COMPOSE_CONTROL_URL = Bun.env.COMPOSE_CONTROL_URL;
const COMPOSE_CONTROL_TOKEN = Bun.env.COMPOSE_CONTROL_TOKEN ?? "";
const TOOL_NETWORK_ALLOWLIST = (Bun.env.TOOL_NETWORK_ALLOWLIST ?? "example.com").split(",").map((x) => x.trim()).filter(Boolean);
const CHANNEL_SHARED_SECRETS: Record<string, string> = {
  webhook: Bun.env.CHANNEL_WEBHOOK_SECRET ?? "",
  telegram: Bun.env.CHANNEL_TELEGRAM_SECRET ?? ""
};
const AUTO_APPROVE_EXTENSIONS = (Bun.env.AUTO_APPROVE_EXTENSIONS ?? "").split(",").map((x) => x.trim()).filter(Boolean);

const memory = new MemoryStore("/app/data/memory.json");
const audit = new AuditLog("/app/data/audit.log");
const extQueue = new ExtensionQueue(EXT_REQUESTS_PATH);
prepareBundleRegistry(CHANGE_STATE_DIR);
const sessions = new Map<string, { userId: string; history: Array<{ role: string; text: string; ts: string }> }>();

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: { "content-type": "application/json" } });
}

function auth(req: Request) {
  return req.headers.get("x-admin-token") === ADMIN_TOKEN;
}

function stepUp(req: Request) {
  return req.headers.get("x-admin-step-up") === ADMIN_STEP_UP_TOKEN;
}

async function restart(service: "opencode" | "gateway" | "openmemory") {
  if (!COMPOSE_CONTROL_URL) return;
  await fetch(`${COMPOSE_CONTROL_URL}/restart/${service}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-compose-control-token": COMPOSE_CONTROL_TOKEN
    },
    body: JSON.stringify({ reason: "admin action" })
  });
}

function explainRecall(query: string, rec: Array<{ id: string; content: string }>) {
  return rec.map((r) => ({ id: r.id, content: r.content, why: `Matched query terms from: ${query}` }));
}

function updateConfigAtomically(mutator: (raw: string) => string) {
  const raw = readFileSync(OPENCODE_CONFIG_PATH, "utf8");
  const backup = snapshotFile(OPENCODE_CONFIG_PATH);
  writeFileSync(OPENCODE_CONFIG_PATH, mutator(raw), "utf8");
  return { backup };
}

async function processMessage(body: Partial<MessageRequest>, requestId: string) {
  const userId = body.userId ?? "default-user";
  const text = body.text?.trim();
  const sessionId = body.sessionId ?? randomUUID();
  if (!text) return json(400, { error: "text is required", requestId });

  const rlKey = `${userId}:${new Date().getUTCMinutes()}`;
  if (!allowRequest(rlKey, 120, 60_000)) return json(429, { error: "rate_limited", requestId });

  const session = sessions.get(sessionId) ?? { userId, history: [] };
  session.history.push({ role: "user", text, ts: new Date().toISOString() });

  const recalls = memory.recall({ userId, query: text, topK: 5 });
  let memoryWrite = null;
  if (canRemember(text)) {
    memoryWrite = memory.remember({ userId, content: text.replace(/^\s*remember\s*/i, "").trim(), tags: ["explicit-save"], source: "user" });
  }

  const toolName = body.toolName ?? "memory_recall";
  const toolCheck = validateToolRequest({ toolName, args: body.toolArgs ?? {}, allowlistDomains: TOOL_NETWORK_ALLOWLIST, approval: body.approval });
  if (!toolCheck.allowed) {
    audit.write({ ts: new Date().toISOString(), requestId, sessionId, userId, action: "tool_firewall", status: "denied", details: { toolName, risk: classifyTool(toolName), reason: toolCheck.reason } });
    return json(403, { requestId, sessionId, denied: true, reason: toolCheck.reason, recalls: explainRecall(text, recalls) });
  }

  const answer = recalls.length
    ? `I found relevant memory:\n${recalls.map((r) => `- (${r.id}) ${r.content}`).join("\n")}\n\nAnswer: ${text}`
    : `I can help with that. ${text}`;

  session.history.push({ role: "assistant", text: answer, ts: new Date().toISOString() });
  sessions.set(sessionId, session);
  audit.write({ ts: new Date().toISOString(), requestId, sessionId, userId, action: "message", status: "ok", details: { toolName, recallCount: recalls.length, memoryWrite: Boolean(memoryWrite) } });
  return json(200, { requestId, sessionId, userId, answer, recalls: explainRecall(text, recalls), memoryWrite });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const requestId = req.headers.get("x-request-id") ?? randomUUID();
    try {
      const url = new URL(req.url);

      if (url.pathname === "/health" && req.method === "GET") return json(200, { ok: true, service: "gateway", time: new Date().toISOString() });
      if (url.pathname === "/message" && req.method === "POST") return processMessage(await req.json(), requestId);

      if (url.pathname === "/channel/inbound" && req.method === "POST") {
        const raw = await req.text();
        const payload = JSON.parse(raw) as ChannelMessage;
        const incomingSig = req.headers.get("x-channel-signature") ?? "";
        const channelSecret = CHANNEL_SHARED_SECRETS[payload.channel] ?? "";
        if (!channelSecret) return json(403, { error: "channel_not_configured" });
        if (!verifySignature(channelSecret, raw, incomingSig)) return json(403, { error: "invalid_signature" });
        if (!verifyReplayProtection(payload.channel, payload.nonce, payload.timestamp)) return json(409, { error: "replay_detected" });
        return processMessage({ userId: payload.userId, text: payload.text, metadata: payload.metadata }, requestId);
      }

      if (url.pathname === "/admin/extensions/request" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        const body = (await req.json()) as { pluginId: string; sourceType?: "npm" | "local"; requestedBy?: string };
        if (!validatePluginIdentifier(body.pluginId)) return json(400, { error: "invalid plugin id" });

        const risk = classifyPluginRisk(body.pluginId);
        const preflight = await preflightPlugin(body.pluginId);
        if (!preflight.ok) return json(400, { error: "preflight_failed", details: preflight.details });

        const autoApproved = AUTO_APPROVE_EXTENSIONS.includes(body.pluginId) && risk !== "critical";
        const item = extQueue.upsert({
          id: randomUUID(),
          pluginId: body.pluginId,
          sourceType: body.sourceType ?? (body.pluginId.startsWith("./") ? "local" : "npm"),
          requestedAt: new Date().toISOString(),
          requestedBy: body.requestedBy ?? "admin",
          status: autoApproved ? "approved" : "pending",
          risk,
          reason: autoApproved ? "policy-auto-approved" : "requires_step_up_apply"
        });

        if (autoApproved) {
          const applied = updatePluginListAtomically(OPENCODE_CONFIG_PATH, item.pluginId, true);
          await restart("opencode");
          item.status = "applied";
          extQueue.upsert(item);
          return json(200, { ok: true, item, applied });
        }
        return json(202, { ok: true, item, next: "POST /admin/extensions/apply" });
      }

      if (url.pathname === "/admin/extensions/list" && req.method === "GET") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        return json(200, { items: extQueue.list() });
      }

      if (url.pathname === "/admin/extensions/apply" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { requestId: string };
        const ext = extQueue.get(body.requestId);
        if (!ext) return json(404, { error: "request_not_found" });
        if (ext.status !== "pending" && ext.status !== "approved") return json(400, { error: "invalid_state", status: ext.status });

        const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, ext.pluginId, true);
        await restart("opencode");
        ext.status = "applied";
        extQueue.upsert(ext);
        return json(200, { ok: true, ext, result });
      }

      if (url.pathname === "/admin/extensions/disable" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { pluginId: string };
        if (!validatePluginIdentifier(body.pluginId)) return json(400, { error: "invalid plugin id" });
        const result = updatePluginListAtomically(OPENCODE_CONFIG_PATH, body.pluginId, false);
        await restart("opencode");
        return json(200, { ok: true, action: "disabled", result });
      }

      if (url.pathname === "/admin/config" && req.method === "GET") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        return new Response(readFileSync(OPENCODE_CONFIG_PATH, "utf8"), { headers: { "content-type": "text/plain" } });
      }

      if (url.pathname === "/admin/config" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { config: string; restart?: boolean };
        const parsed = parseJsonc(body.config);
        if (typeof parsed !== "object") return json(400, { error: "invalid jsonc" });
        const permissions = (parsed as Record<string, unknown>).permission as Record<string, string> | undefined;
        if (permissions && Object.values(permissions).some((v) => v === "allow")) return json(400, { error: "policy lint failed: permission widening blocked" });

        const backup = snapshotFile(OPENCODE_CONFIG_PATH);
        writeFileSync(OPENCODE_CONFIG_PATH, body.config, "utf8");
        if (body.restart ?? true) await restart("opencode");
        return json(200, { ok: true, backup });
      }

      if (url.pathname === "/admin/change/propose" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        const body = (await req.json()) as { bundleId: string };
        const path = `${CHANGE_BUNDLE_DIR}/${body.bundleId}`;
        if (!existsSync(path)) return json(404, { error: "bundle not found" });
        const metrics = collectBundleMetrics(path);
        const stateId = registerBundleState(CHANGE_STATE_DIR, { id: body.bundleId, stage: "proposed", createdAt: new Date().toISOString(), metrics });
        return json(200, { ok: true, stateId, metrics });
      }

      if (url.pathname === "/admin/change/validate" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        const body = (await req.json()) as { bundleId: string };
        const path = `${CHANGE_BUNDLE_DIR}/${body.bundleId}`;
        const valid = validateBundle(path);
        const risk = classifyBundleRisk(path);
        const stateId = registerBundleState(CHANGE_STATE_DIR, { id: body.bundleId, stage: "validated", valid, risk, validatedAt: new Date().toISOString() });
        return json(valid.ok ? 200 : 400, { ok: valid.ok, stateId, risk, ...valid });
      }

      if (url.pathname === "/admin/change/apply" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { bundleId: string; applyPlugins?: string[]; restart?: boolean };
        const path = `${CHANGE_BUNDLE_DIR}/${body.bundleId}`;
        const valid = validateBundle(path);
        if (!valid.ok) return json(400, { ok: false, errors: valid.errors });

        const outcome = updateConfigAtomically((raw) => {
          const doc = parseJsonc(raw) as { plugin?: string[] } & Record<string, unknown>;
          const plugins = new Set(Array.isArray(doc.plugin) ? doc.plugin : []);
          for (const p of body.applyPlugins ?? []) plugins.add(p);
          return stringifyPretty({ ...doc, plugin: [...plugins] });
        });

        registerBundleState(CHANGE_STATE_DIR, { id: body.bundleId, stage: "applied", backup: outcome.backup, appliedAt: new Date().toISOString() });
        if (body.restart ?? true) await restart("opencode");
        return json(200, { ok: true, backup: outcome.backup });
      }

      if (url.pathname === "/admin/change/rollback" && req.method === "POST") {
        if (!auth(req)) return json(401, { error: "admin token required" });
        if (!stepUp(req)) return json(403, { error: "step-up token required" });
        const body = (await req.json()) as { backupPath: string; restart?: boolean };
        const backup = readFileSync(body.backupPath, "utf8");
        writeFileSync(OPENCODE_CONFIG_PATH, backup, "utf8");
        if (body.restart ?? true) await restart("opencode");
        return json(200, { ok: true, restoredFrom: body.backupPath });
      }

      if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
        return new Response(Bun.file("/app/admin-ui/index.html"));
      }

      return json(404, { error: "not_found" });
    } catch (error) {
      audit.write({ ts: new Date().toISOString(), requestId, action: "server", status: "error", details: { error: String(error) } });
      return json(500, { error: "internal_error" });
    }
  }
});

console.log(JSON.stringify({ kind: "startup", port: server.port }));
