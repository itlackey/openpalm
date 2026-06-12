/**
 * Live E2E of the guardian /oc/* proxy path using the baked OpenCode client,
 * run inside a throwaway container on the channel_lan network (the guardian has no
 * host port). Drives exactly what the Discord/Slack/API renderers do:
 *   create session -> open filtered /event -> prompt_async -> stream deltas to
 *   turn-end -> abort/delete. Proves signing, allowlist, ownership, /event
 *   ownership-filter + fan-out, sessionID correlation, and turn-end — end to end
 *   against the live assistant. NO Discord required.
 *
 * Env: OC_CHANNEL, OC_SECRET, OC_USER, OC_PROMPT, OC_EXPECT_TOOL ("1" to wait for
 * permission.asked and reply). Exits non-zero on failure.
 */
import { OcClient, asRaw, partSnapshotType, extractTextDelta, extractToolUpdate, extractPermissionAsk, isTurnEnd, isSessionError } from '/app/portals/discord/src/runtime.ts';

const channel = Bun.env.OC_CHANNEL ?? "discord";
const secret = Bun.env.OC_SECRET ?? "";
const userId = Bun.env.OC_USER ?? "discord:e2e";
const prompt = Bun.env.OC_PROMPT ?? "Reply with a short one-sentence greeting. Do not use any tools.";
const expectTool = Bun.env.OC_EXPECT_TOOL === "1";
if (!secret) { console.error("OC_SECRET required"); process.exit(2); }

const client = new OcClient({ channel, secret });
const ac = new AbortController();
let ok = true;
const log = (...a: unknown[]) => console.log("[e2e]", ...a);

// 1) Open the persistent filtered /event subscription FIRST (§3.2 ordering).
const events: unknown[] = [];
const evDone = (async () => {
  try {
    for await (const ev of client.events(userId, ac.signal)) events.push(ev);
  } catch (e) { if (!ac.signal.aborted) log("events stream error:", String(e)); }
})();
await Bun.sleep(800); // let the subscription establish

// 2) Create a session (guardian rewrites the title + records ownership).
const sessionKey = `${channel}:e2e:${Date.now()}`;
const session = await client.createSession(userId, sessionKey);
log("session created:", session.id, "title=", session.title);
if (!session.id) { console.error("no session id"); process.exit(1); }

// 3) send the turn (no client messageID — OpenCode no-ops follow-ups otherwise).
log("prompt expectTool:", expectTool);
await client.prompt(userId, session.id, prompt);

// 4) Render: accumulate text deltas, tool updates, handle permission, to turn-end.
let text = "";
let tool = "";
const reasoningParts = new Set<string>();
let permissionReplied = false;
let turnEnded = false;
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  // drain what we have
  while (events.length) {
    const e = asRaw(events.shift());
    const snap = partSnapshotType(e);
    if (snap && snap.type === "reasoning") reasoningParts.add(snap.partID);
    const d = extractTextDelta(e, session.id, reasoningParts);
    if (d) { text += d; continue; }
    const t = extractToolUpdate(e, session.id);
    if (t && t.callID) { tool = `${t.tool}:${t.status}`; continue; }
    const ask = extractPermissionAsk(e, session.id);
    if (ask && expectTool && !permissionReplied) {
      log("permission.asked:", JSON.stringify(ask));
      const okReply = await client.replyPermission(userId, ask.requestID, "once");
      log("replyPermission ->", okReply);
      permissionReplied = true;
      continue;
    }
    if (isSessionError(e, session.id)) { log("session.error frame (upstream reset)"); }
    if (isTurnEnd(e, session.id)) { turnEnded = true; }
  }
  if (turnEnded) break;
  await Bun.sleep(300);
}

log("=== RESULT ===");
log("streamed text length:", text.length);
log("text sample:", JSON.stringify(text.slice(0, 200)));
log("last tool:", tool || "(none)");
log("permission replied:", permissionReplied);
log("turn ended:", turnEnded);
log("total events seen:", events.length, "(drained)");

if (text.length === 0 && !expectTool) { console.error("FAIL: no streamed text"); ok = false; }
if (expectTool && !permissionReplied) { console.error("FAIL: expected a permission.asked but none fired"); ok = false; }
if (!turnEnded) { console.error("FAIL: turn never reached idle"); ok = false; }

// 5) Clean up: delete the session (ownership-checked).
try { await client.deleteSession(userId, session.id); log("session deleted"); } catch (e) { log("delete err:", String(e)); }
ac.abort();
await Promise.race([evDone, Bun.sleep(500)]);
log(ok ? "=== PASS ===" : "=== FAIL ===");
process.exit(ok ? 0 : 1);
