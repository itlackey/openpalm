import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  startServer,
  stopServer,
  authedGet,
  authedPost,
  runMinimalSetup,
  claimPort,
} from "./helpers";

claimPort(10);

describe("container and automation management api", () => {
  beforeAll(async () => {
    await startServer();
    await runMinimalSetup();
  });

  afterAll(() => {
    stopServer();
  });

  it("GET /containers excludes admin and caddy", async () => {
    const res = await authedGet("/containers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.services)).toBe(true);
    expect(body.services).not.toContain("admin");
    expect(body.services).not.toContain("caddy");
  });

  it("GET /automations/history returns logs for known automation id", async () => {
    const createRes = await authedPost("/automations", {
      name: "Logs Automation",
      schedule: "*/30 * * * *",
      script: "echo logs",
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const id = created.automation?.id as string;
    expect(id.length).toBeGreaterThan(0);

    const logsRes = await authedGet(
      `/automations/history?id=${encodeURIComponent(id)}`
    );
    expect(logsRes.status).toBe(200);
    const body = await logsRes.json();
    expect(body.id).toBe(id);
    expect(Array.isArray(body.logs)).toBe(true);
  });
});
