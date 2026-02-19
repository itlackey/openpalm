import { describe, expect, it } from "bun:test";
import { ALLOWED, createControllerFetch } from "./server.ts";

describe("controller server", () => {
  it("serves health without auth", async () => {
    const fetchHandler = createControllerFetch("token", async () => ({ ok: true, stdout: "", stderr: "" }));
    const resp = await fetchHandler(new Request("http://controller/health"));
    expect(resp.status).toBe(200);
  });

  it("rejects missing token", async () => {
    const fetchHandler = createControllerFetch("token", async () => ({ ok: true, stdout: "", stderr: "" }));
    const resp = await fetchHandler(new Request("http://controller/containers"));
    expect(resp.status).toBe(401);
  });

  it("filters allowed services and shapes compose responses", async () => {
    const calls: string[][] = [];
    const fetchHandler = createControllerFetch("token", async (args) => {
      calls.push(args);
      return { ok: true, stdout: "ok", stderr: "" };
    });

    const bad = await fetchHandler(new Request("http://controller/restart/not-allowed", { method: "POST", headers: { "x-controller-token": "token" } }));
    expect(bad.status).toBe(400);

    const service = [...ALLOWED][0];
    const good = await fetchHandler(new Request(`http://controller/restart/${service}`, { method: "POST", headers: { "x-controller-token": "token" } }));
    expect(good.status).toBe(200);
    expect(calls[0]).toEqual(["restart", service]);
  });
});
