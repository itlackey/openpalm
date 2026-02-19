import { describe, expect, it } from "bun:test";
import { createControllerFetch } from "../../controller/server.ts";
import { createChatFetch } from "../../channels/chat/server.ts";

describe("security: auth", () => {
  it("controller rejects requests without x-controller-token", async () => {
    const fetchHandler = createControllerFetch("token", async () => ({ ok: true, stdout: "", stderr: "" }));
    const resp = await fetchHandler(new Request("http://controller/containers"));
    expect(resp.status).toBe(401);
  });

  it("chat adapter rejects inbound without x-chat-token when configured", async () => {
    const fetchHandler = createChatFetch("http://gateway", "secret", "token", fetch);
    const resp = await fetchHandler(new Request("http://chat/chat", { method: "POST", body: JSON.stringify({ text: "hello" }) }));
    expect(resp.status).toBe(401);
  });
});
