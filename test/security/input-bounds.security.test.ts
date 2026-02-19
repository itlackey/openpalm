import { describe, expect, it } from "bun:test";
import { createChatFetch } from "../../channels/chat/server.ts";

describe("security: input bounds", () => {
  it("rejects missing text", async () => {
    const fetchHandler = createChatFetch("http://gateway", "secret", "", fetch);
    const resp = await fetchHandler(new Request("http://chat/chat", { method: "POST", body: JSON.stringify({}) }));
    expect(resp.status).toBe(400);
  });
});
