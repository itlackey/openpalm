import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import {
  startServer,
  stopServer,
  authedGet,
  authedPost,
  runMinimalSetup,
  claimPort,
} from "./helpers";

claimPort(5);

describe("automations", () => {
  beforeAll(async () => {
    await startServer();
    await runMinimalSetup();
  });

  afterAll(() => {
    stopServer();
  });

  it("GET /automations returns list with core automations", async () => {
    const res = await authedGet("/automations");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.automations).toBeDefined();
    expect(Array.isArray(body.automations)).toBe(true);
  });

  it("POST /automations creates new automation", async () => {
    const res = await authedPost("/automations", {
      name: "Test Automation",
      schedule: "0 * * * *",
      script: "echo hello",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.automation).toBeDefined();
  });

  it("POST /automations with invalid cron returns 400", async () => {
    const res = await authedPost("/automations", {
      name: "Bad Cron",
      schedule: "not-a-cron",
      script: "echo bad",
    });
    expect(res.status).toBe(400);
  });

  it("POST /automations/update updates automation", async () => {
    const listRes = await authedGet("/automations");
    const listBody = await listRes.json();
    let nonCore = listBody.automations.find(
      (a: { core?: boolean }) => !a.core
    );
    if (!nonCore) {
      const createRes = await authedPost("/automations", {
        name: "Update Seed Automation",
        schedule: "15 * * * *",
        script: "echo seed"
      });
      expect(createRes.status).toBe(201);
      const createBody = await createRes.json();
      nonCore = createBody.automation;
    }

    const res = await authedPost("/automations/update", {
      id: nonCore.id,
      name: "Updated Automation",
      schedule: "30 * * * *",
      script: "echo updated",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("POST /automations/delete deletes automation", async () => {
    const listRes = await authedGet("/automations");
    const listBody = await listRes.json();
    let nonCore = listBody.automations.find(
      (a: { core?: boolean }) => !a.core
    );
    if (!nonCore) {
      const createRes = await authedPost("/automations", {
        name: "Delete Seed Automation",
        schedule: "45 * * * *",
        script: "echo delete-seed"
      });
      expect(createRes.status).toBe(201);
      const createBody = await createRes.json();
      nonCore = createBody.automation;
    }

    const res = await authedPost("/automations/delete", { id: nonCore.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it("core automations cannot be deleted", async () => {
    const listRes = await authedGet("/automations");
    const listBody = await listRes.json();
    const core = listBody.automations.find(
      (a: { core?: boolean }) => a.core === true
    );
    expect(core).toBeDefined();

    const res = await authedPost("/automations/delete", { id: core.id });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("cannot_delete_core");
  });
});
