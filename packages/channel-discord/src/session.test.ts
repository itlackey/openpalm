import { describe, expect, it } from "bun:test";
import {
  buildChannelUserSessionKey,
  buildThreadSessionKey,
  ConversationQueue,
  resolveInteractionSessionKey,
} from "./session.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("session keys", () => {
  it("builds a thread-scoped session key", () => {
    expect(buildThreadSessionKey("thread-123")).toBe("discord:thread:thread-123");
  });

  it("builds a channel-user session key", () => {
    expect(buildChannelUserSessionKey("channel-1", "user-1")).toBe("discord:channel:channel-1:user:user-1");
  });

  it("prefers thread session keys for interactions", () => {
    expect(
      resolveInteractionSessionKey({
        channelId: "channel-1",
        userId: "user-1",
        threadId: "thread-1",
      }),
    ).toBe("discord:thread:thread-1");
  });

  it("falls back to channel-user session keys for non-thread interactions", () => {
    expect(
      resolveInteractionSessionKey({
        channelId: "channel-1",
        userId: "user-1",
      }),
    ).toBe("discord:channel:channel-1:user:user-1");
  });
});

describe("ConversationQueue", () => {
  it("runs queued work sequentially", async () => {
    const queue = new ConversationQueue();
    const blocker = deferred();
    const events: string[] = [];

    const first = queue.runOrQueue("session-1", {
      run: async () => {
        events.push("first:start");
        await blocker.promise;
        events.push("first:end");
      },
    });

    const second = queue.runOrQueue("session-1", {
      onQueued: async () => {
        events.push("second:queued");
      },
      run: async () => {
        events.push("second:run");
      },
    });

    expect(await second).toBe("queued");
    expect(queue.queuedCount("session-1")).toBe(1);

    blocker.resolve();
    expect(await first).toBe("started");

    await Bun.sleep(0);
    expect(events).toEqual(["first:start", "second:queued", "first:end", "second:run"]);
    expect(queue.isProcessing("session-1")).toBe(false);
  });

  it("drops queued work when cleared", async () => {
    const queue = new ConversationQueue();
    const blocker = deferred();
    const events: string[] = [];

    const first = queue.runOrQueue("session-1", {
      run: async () => {
        events.push("first:start");
        await blocker.promise;
        events.push("first:end");
      },
    });

    await queue.runOrQueue("session-1", {
      run: async () => {
        events.push("second:run");
      },
    });

    expect(queue.clear("session-1")).toBe(1);

    blocker.resolve();
    await first;
    await Bun.sleep(0);

    expect(events).toEqual(["first:start", "first:end"]);
    expect(queue.queuedCount("session-1")).toBe(0);
  });
});
