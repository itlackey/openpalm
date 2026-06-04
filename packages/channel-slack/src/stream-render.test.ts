/**
 * Slack rich-UX renderer — PURE Block Kit + registry-authorization tests (§4.3).
 *
 * The live Slack side-effects (chat.postMessage/update, real button clicks via
 * app.action) need a live Slack workspace and are stated in needsLiveVerification.
 * What IS unit-provable here is the security/correctness-load-bearing logic:
 *   - Block Kit buttons carry the requestID/sessionId in `value` so the central
 *     action handler can route them (no per-message collector on Slack);
 *   - the permission registry enforces interaction identity (only the requesting
 *     Slack user may decide — §4.3) and maps Approve/Always/Deny → the correct
 *     signed `reply` relayed through the OcClient;
 *   - the Stop registry is likewise identity-gated.
 *
 * The native-OpenCode event interpretation itself is the SHARED channels-sdk
 * logic (oc-events.test.ts) — not retested here.
 */
import { describe, test, expect } from "bun:test";
import {
  SlackPermissionRegistry,
  buildPermissionBlocks,
  buildAnswerBlocks,
  buildToolBlocks,
  ACTION_PERM_ONCE,
  ACTION_PERM_ALWAYS,
  ACTION_PERM_DENY,
} from "./stream-render.ts";
import type { OcClient } from "@openpalm/channels-sdk";

// A hand-written OcClient stub recording the calls the registry makes.
function stubClient(): { client: OcClient; replies: Array<{ userId: string; requestID: string; reply: string }>; aborts: Array<{ userId: string; sessionId: string }>; fail?: boolean } {
  const replies: Array<{ userId: string; requestID: string; reply: string }> = [];
  const aborts: Array<{ userId: string; sessionId: string }> = [];
  const holder = { fail: false };
  const client = {
    async replyPermission(userId: string, requestID: string, reply: string) {
      if (holder.fail) throw new Error("expired");
      replies.push({ userId, requestID, reply });
      return true;
    },
    async abort(userId: string, sessionId: string) {
      aborts.push({ userId, sessionId });
    },
  } as unknown as OcClient;
  return { client, replies, aborts, ...holder };
}

describe("buildPermissionBlocks — buttons route by value (§4.3)", () => {
  test("each button carries the requestID in value", () => {
    const blocks = buildPermissionBlocks({ requestID: "per_9", permission: "bash", patterns: ["echo *"] }) as any[];
    const actions = blocks.find((b) => b.type === "actions");
    const ids = actions.elements.map((e: any) => e.action_id);
    expect(ids).toEqual([ACTION_PERM_ONCE, ACTION_PERM_ALWAYS, ACTION_PERM_DENY]);
    for (const el of actions.elements) expect(el.value).toBe("per_9");
  });

  test("the prompt section names the permission + patterns", () => {
    const blocks = buildPermissionBlocks({ requestID: "per_1", permission: "bash", patterns: ["echo *"] }) as any[];
    expect(blocks[0].text.text).toContain("bash");
    expect(blocks[0].text.text).toContain("echo *");
  });
});

describe("buildAnswerBlocks — Stop button carries the sessionId", () => {
  test("stop button value is the sessionId", () => {
    const blocks = buildAnswerBlocks("hello", "ses_42") as any[];
    const actions = blocks.find((b) => b.type === "actions");
    expect(actions.elements[0].value).toBe("ses_42");
  });
});

describe("buildToolBlocks — context block names the tool + status", () => {
  test("renders tool + status", () => {
    const blocks = buildToolBlocks({ callID: "c1", tool: "bash", status: "running", title: "echo hi" }) as any[];
    expect(blocks[0].type).toBe("context");
    expect(blocks[0].elements[0].text).toContain("bash");
    expect(blocks[0].elements[0].text).toContain("echo hi");
  });
});

describe("SlackPermissionRegistry — interaction identity + reply relay (§4.3)", () => {
  test("Approve → reply:once relayed through the OcClient", async () => {
    const { client, replies } = stubClient();
    const reg = new SlackPermissionRegistry(client);
    reg.registerPermission("per_1", { userId: "slack:U1", requestingUserId: "U1", permission: "bash", channel: "C1", ts: "1.1" });

    const out = await reg.handlePermissionClick("per_1", ACTION_PERM_ONCE, "U1");
    expect(out).not.toBeNull();
    expect(replies).toEqual([{ userId: "slack:U1", requestID: "per_1", reply: "once" }]);
    expect(out!.text).toContain("once");
  });

  test("Always → reply:always; Deny → reply:reject", async () => {
    const { client, replies } = stubClient();
    const reg = new SlackPermissionRegistry(client);
    reg.registerPermission("a", { userId: "slack:U1", requestingUserId: "U1", permission: "bash", channel: "C1", ts: "1" });
    reg.registerPermission("b", { userId: "slack:U1", requestingUserId: "U1", permission: "bash", channel: "C1", ts: "2" });
    await reg.handlePermissionClick("a", ACTION_PERM_ALWAYS, "U1");
    await reg.handlePermissionClick("b", ACTION_PERM_DENY, "U1");
    expect(replies.map((r) => r.reply)).toEqual(["always", "reject"]);
  });

  test("a DIFFERENT Slack user cannot answer the prompt (interaction identity)", async () => {
    const { client, replies } = stubClient();
    const reg = new SlackPermissionRegistry(client);
    reg.registerPermission("per_1", { userId: "slack:U1", requestingUserId: "U1", permission: "bash", channel: "C1", ts: "1.1" });

    const out = await reg.handlePermissionClick("per_1", ACTION_PERM_ONCE, "U_ATTACKER");
    expect(out).toBeNull();
    expect(replies).toHaveLength(0);
  });

  test("an unknown/expired requestID is refused", async () => {
    const { client } = stubClient();
    const reg = new SlackPermissionRegistry(client);
    expect(await reg.handlePermissionClick("ghost", ACTION_PERM_ONCE, "U1")).toBeNull();
  });

  test("a failed reply still resolves with a user-facing message and clears the entry", async () => {
    const s = stubClient();
    s.fail = true;
    // rebuild client to capture the flipped flag
    const replies: Array<{ userId: string; requestID: string; reply: string }> = [];
    const client = {
      async replyPermission() { throw new Error("expired"); },
      async abort() {},
    } as unknown as OcClient;
    const reg = new SlackPermissionRegistry(client);
    reg.registerPermission("per_1", { userId: "slack:U1", requestingUserId: "U1", permission: "bash", channel: "C1", ts: "1.1" });
    const out = await reg.handlePermissionClick("per_1", ACTION_PERM_ONCE, "U1");
    expect(out).not.toBeNull();
    expect(out!.text).toContain("Could not record");
    // second click finds nothing (entry cleared)
    expect(await reg.handlePermissionClick("per_1", ACTION_PERM_ONCE, "U1")).toBeNull();
    expect(replies).toHaveLength(0);
  });

  test("Stop is identity-gated and issues the abort for the owner", async () => {
    const { client, aborts } = stubClient();
    const reg = new SlackPermissionRegistry(client);
    reg.registerStop("ses_1", { userId: "slack:U1", requestingUserId: "U1", sessionId: "ses_1" });

    expect(await reg.handleStopClick("ses_1", "U_OTHER")).toBe(false);
    expect(aborts).toHaveLength(0);

    expect(await reg.handleStopClick("ses_1", "U1")).toBe(true);
    expect(aborts).toEqual([{ userId: "slack:U1", sessionId: "ses_1" }]);
  });

  test("clearStop removes the stop control", async () => {
    const { client } = stubClient();
    const reg = new SlackPermissionRegistry(client);
    reg.registerStop("ses_1", { userId: "slack:U1", requestingUserId: "U1", sessionId: "ses_1" });
    reg.clearStop("ses_1");
    expect(await reg.handleStopClick("ses_1", "U1")).toBe(false);
  });

  test("an unclicked permission entry past its TTL is pruned (no unbounded leak)", async () => {
    const { client } = stubClient();
    const reg = new SlackPermissionRegistry(client);
    // An old, never-clicked prompt (registered > TTL ago).
    reg.registerPermission("stale", {
      userId: "slack:U1", requestingUserId: "U1", permission: "bash", channel: "C1", ts: "1",
      createdAt: Date.now() - 16 * 60_000, // default TTL is 15 min
    });
    expect(reg.pendingPermissionCount()).toBe(1);
    // A fresh register triggers the lazy prune, evicting the stale entry.
    reg.registerPermission("fresh", { userId: "slack:U1", requestingUserId: "U1", permission: "bash", channel: "C1", ts: "2" });
    expect(reg.pendingPermissionCount()).toBe(1); // only "fresh" survives
    expect(await reg.handlePermissionClick("stale", ACTION_PERM_ONCE, "U1")).toBeNull(); // gone
  });
});
