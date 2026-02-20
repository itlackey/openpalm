import { describe, expect, it } from "bun:test";
import { createControllerFetch } from "../../controller/server.ts";

describe("integration: admin -> controller", () => {
  it("controller list and auth behavior", async () => {
    const controller = Bun.serve({
      port: 0,
      fetch: createControllerFetch("controller-token", async (args) => {
        if (args[0] === "ps") return { ok: true, stdout: '[{"name":"gateway"}]', stderr: "" };
        return { ok: true, stdout: "ok", stderr: "" };
      })
    });

    try {
      const unauth = await fetch(`http://localhost:${controller.port}/containers`);
      expect(unauth.status).toBe(401);

      const authed = await fetch(`http://localhost:${controller.port}/containers`, { headers: { "x-controller-token": "controller-token" } });
      expect(authed.status).toBe(200);
      const body = await authed.json() as { ok: boolean; containers: Array<{ name: string }> };
      expect(body.ok).toBe(true);
      expect(body.containers).toBeArrayOfSize(1);
      expect(body.containers[0].name).toBe("gateway");
    } finally {
      controller.stop();
    }
  });
});
