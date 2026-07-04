/**
 * Unit tests for `deliverBufferedAnswer` — the shared buffered-turn delivery
 * block hoisted out of the Discord and Slack portals.
 *
 * These pin the split → first-chunk → follow-up → error-post contract against a
 * fake sink: multi-chunk posting order, the empty-answer sentinel, the
 * missing-answer-key sentinel, and that a thrown forward (or non-ok response)
 * yields exactly one `Error: …` post.
 */
import { describe, test, expect } from "bun:test";
import { deliverBufferedAnswer, type DeliverySink } from "./deliver-buffered.ts";

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

type Call = { kind: "post" | "edit"; text: string };

function makeSink(withEdit: boolean): { sink: DeliverySink; calls: Call[] } {
  const calls: Call[] = [];
  const sink: DeliverySink = {
    postChunk: async (text: string) => {
      calls.push({ kind: "post", text });
    },
  };
  if (withEdit) {
    sink.editChunk = async (text: string) => {
      calls.push({ kind: "edit", text });
    };
  }
  return { sink, calls };
}

describe("deliverBufferedAnswer", () => {
  test("edit-capable sink: first chunk edits, remaining chunks post in order", async () => {
    const { sink, calls } = makeSink(true);
    const answer = "aaaa" + "bbbb" + "cccc"; // 12 chars, maxLength 4 → 3 chunks
    const result = await deliverBufferedAnswer({
      forward: async () => okResponse({ answer }),
      sink,
      maxLength: 4,
    });

    expect(result).toEqual({ ok: true, answer, chunks: ["aaaa", "bbbb", "cccc"] });
    expect(calls).toEqual([
      { kind: "edit", text: "aaaa" },
      { kind: "post", text: "bbbb" },
      { kind: "post", text: "cccc" },
    ]);
  });

  test("post-only sink: every chunk posts in order (first chunk via postChunk)", async () => {
    const { sink, calls } = makeSink(false);
    const answer = "11112222"; // 8 chars, maxLength 4 → 2 chunks
    const result = await deliverBufferedAnswer({
      forward: async () => okResponse({ answer }),
      sink,
      maxLength: 4,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { kind: "post", text: "1111" },
      { kind: "post", text: "2222" },
    ]);
  });

  test("empty answer string falls back to the 'No response received.' sentinel", async () => {
    const { sink, calls } = makeSink(true);
    const result = await deliverBufferedAnswer({
      forward: async () => okResponse({ answer: "" }),
      sink,
      maxLength: 100,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ kind: "edit", text: "No response received." }]);
  });

  test("missing answer key falls back to the sentinel", async () => {
    const { sink, calls } = makeSink(false);
    const result = await deliverBufferedAnswer({
      forward: async () => okResponse({}),
      sink,
      maxLength: 100,
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ kind: "post", text: "No response received." }]);
  });

  test("a thrown forward results in exactly one 'Error: …' post", async () => {
    const { sink, calls } = makeSink(false);
    const result = await deliverBufferedAnswer({
      forward: async () => {
        throw new Error("boom");
      },
      sink,
      maxLength: 100,
    });

    expect(result).toEqual({ ok: false, error: "boom" });
    expect(calls).toEqual([{ kind: "post", text: "Error: boom" }]);
  });

  test("a non-ok response throws the guardian-status error and edits it once", async () => {
    const { sink, calls } = makeSink(true);
    const result = await deliverBufferedAnswer({
      forward: async () => new Response("nope", { status: 500 }),
      sink,
      maxLength: 100,
    });

    expect(result).toEqual({ ok: false, error: "Guardian returned status 500" });
    expect(calls).toEqual([{ kind: "edit", text: "Error: Guardian returned status 500" }]);
  });

  test("onSettled fires before delivery on success", async () => {
    const { sink, calls } = makeSink(true);
    const order: string[] = [];
    await deliverBufferedAnswer({
      forward: async () => okResponse({ answer: "hi" }),
      sink: {
        postChunk: sink.postChunk,
        editChunk: async (text) => {
          order.push(`edit:${text}`);
        },
      },
      maxLength: 100,
      onSettled: () => {
        order.push("settled");
      },
    });

    expect(order).toEqual(["settled", "edit:hi"]);
    expect(calls).toEqual([]);
  });

  test("onSettled fires before the error post when forward throws", async () => {
    const order: string[] = [];
    await deliverBufferedAnswer({
      forward: async () => {
        throw new Error("nope");
      },
      sink: {
        postChunk: async (text) => {
          order.push(`post:${text}`);
        },
      },
      maxLength: 100,
      onSettled: () => {
        order.push("settled");
      },
    });

    expect(order).toEqual(["settled", "post:Error: nope"]);
  });

  test("custom sentinel is honored for the empty-answer fallback", async () => {
    const { sink, calls } = makeSink(false);
    await deliverBufferedAnswer({
      forward: async () => okResponse({ answer: "" }),
      sink,
      maxLength: 100,
      sentinel: "(nothing)",
    });

    expect(calls).toEqual([{ kind: "post", text: "(nothing)" }]);
  });
});
