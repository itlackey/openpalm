import { randomUUID } from "node:crypto";
import { MemoryStore } from "./memory.ts";
import { canRemember, classifyTool, validateToolRequest } from "./policy.ts";
import { AuditLog } from "./audit.ts";
import { verifyReplayProtection, verifySignature } from "./channel-security.ts";
import { allowRequest } from "./rate-limit.ts";
import type { ChannelMessage, MessageRequest } from "./types.ts";

const PORT = Number(Bun.env.PORT ?? 8080);
const TOOL_NETWORK_ALLOWLIST = (Bun.env.TOOL_NETWORK_ALLOWLIST ?? "example.com").split(",").map((x) => x.trim()).filter(Boolean);
const CHANNEL_SHARED_SECRETS: Record<string, string> = {
  chat: Bun.env.CHANNEL_CHAT_SECRET ?? "",
  discord: Bun.env.CHANNEL_DISCORD_SECRET ?? "",
  voice: Bun.env.CHANNEL_VOICE_SECRET ?? "",
  telegram: Bun.env.CHANNEL_TELEGRAM_SECRET ?? ""
};

const memory = new MemoryStore("/app/data/memory.json");
const audit = new AuditLog("/app/data/audit.log");
const sessions = new Map<string, { userId: string; history: Array<{ role: string; text: string; ts: string }> }>();

function json(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload, null, 2), { status, headers: { "content-type": "application/json" } });
}

function explainRecall(query: string, rec: Array<{ id: string; content: string }>) {
  return rec.map((r) => ({ id: r.id, content: r.content, why: `Matched query terms from: ${query}` }));
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

      // All channel inbound — defense in depth: every channel passes through here
      if (url.pathname === "/channel/inbound" && req.method === "POST") {
        const raw = await req.text();
        const payload = JSON.parse(raw) as ChannelMessage;
        const incomingSig = req.headers.get("x-channel-signature") ?? "";
        const channelSecret = CHANNEL_SHARED_SECRETS[payload.channel] ?? "";
        if (!channelSecret) return json(403, { error: "channel_not_configured" });
        if (!verifySignature(channelSecret, raw, incomingSig)) return json(403, { error: "invalid_signature" });
        if (!verifyReplayProtection(payload.channel, payload.nonce, payload.timestamp)) return json(409, { error: "replay_detected" });
        audit.write({ ts: new Date().toISOString(), requestId, action: "channel_inbound", status: "ok", details: { channel: payload.channel, userId: payload.userId } });
        return processMessage({ userId: payload.userId, text: payload.text, metadata: payload.metadata }, requestId);
      }

      return json(404, { error: "not_found" });
    } catch (error) {
      audit.write({ ts: new Date().toISOString(), requestId, action: "server", status: "error", details: { error: String(error) } });
      return json(500, { error: "internal_error" });
    }
  }
});

console.log(JSON.stringify({ kind: "startup", port: server.port }));
