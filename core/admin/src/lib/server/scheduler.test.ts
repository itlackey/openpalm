/**
 * Tests for the in-process automation scheduler.
 *
 * Verifies:
 * 1. YAML parsing and validation (valid, invalid, defaults)
 * 2. Schedule preset resolution
 * 3. Automation loading from directory
 * 4. Scheduler start/stop lifecycle
 * 5. executeAction integration (http action with real HTTP server)
 * 6. Scheduler fires cron job and records execution log
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import {
  parseAutomationYaml,
  resolveSchedule,
  SCHEDULE_PRESETS,
  loadAutomations,
  startScheduler,
  stopScheduler,
  getSchedulerStatus,
  getExecutionLog,
  executeAction
} from "./scheduler.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-sched-test-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── parseAutomationYaml ──────────────────────────────────────────────

describe("parseAutomationYaml", () => {
  test("parses valid api automation", () => {
    const yaml = `
name: Health Check
description: Monitor services
schedule: "*/5 * * * *"
enabled: true
action:
  type: api
  method: GET
  path: /health
`;
    const config = parseAutomationYaml(yaml, "health-check.yml");
    expect(config).not.toBeNull();
    expect(config!.name).toBe("Health Check");
    expect(config!.description).toBe("Monitor services");
    expect(config!.schedule).toBe("*/5 * * * *");
    expect(config!.enabled).toBe(true);
    expect(config!.action.type).toBe("api");
    expect(config!.action.method).toBe("GET");
    expect(config!.action.path).toBe("/health");
    expect(config!.timezone).toBe("UTC");
    expect(config!.on_failure).toBe("log");
  });

  test("parses valid http automation", () => {
    const yaml = `
schedule: daily-8am
action:
  type: http
  method: POST
  url: http://channel-chat:8181/v1/chat/completions
  body:
    model: default
    messages:
      - role: user
        content: Good morning
`;
    const config = parseAutomationYaml(yaml, "prompt.yml");
    expect(config).not.toBeNull();
    expect(config!.action.type).toBe("http");
    expect(config!.action.url).toBe("http://channel-chat:8181/v1/chat/completions");
    expect(config!.action.body).toEqual({
      model: "default",
      messages: [{ role: "user", content: "Good morning" }]
    });
    // preset should be resolved
    expect(config!.schedule).toBe("0 8 * * *");
  });

  test("parses valid shell automation", () => {
    const yaml = `
schedule: weekly-sunday-4am
action:
  type: shell
  command:
    - /bin/bash
    - -c
    - "tail -n 10000 /state/audit/audit.jsonl > /tmp/audit.tmp && mv /tmp/audit.tmp /state/audit/audit.jsonl"
`;
    const config = parseAutomationYaml(yaml, "cleanup.yml");
    expect(config).not.toBeNull();
    expect(config!.action.type).toBe("shell");
    expect(config!.action.command).toEqual([
      "/bin/bash",
      "-c",
      "tail -n 10000 /state/audit/audit.jsonl > /tmp/audit.tmp && mv /tmp/audit.tmp /state/audit/audit.jsonl"
    ]);
    expect(config!.schedule).toBe("0 4 * * 0");
  });

  test("applies defaults for optional fields", () => {
    const yaml = `
schedule: "0 0 * * *"
action:
  type: api
  path: /health
`;
    const config = parseAutomationYaml(yaml, "minimal.yml");
    expect(config).not.toBeNull();
    expect(config!.name).toBe("minimal");
    expect(config!.description).toBe("");
    expect(config!.timezone).toBe("UTC");
    expect(config!.enabled).toBe(true);
    expect(config!.on_failure).toBe("log");
    expect(config!.action.method).toBe("GET");
    expect(config!.action.timeout).toBe(30_000);
  });

  test("respects enabled: false", () => {
    const yaml = `
schedule: daily
enabled: false
action:
  type: api
  path: /health
`;
    const config = parseAutomationYaml(yaml, "disabled.yml");
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(false);
  });

  test("respects on_failure: audit", () => {
    const yaml = `
schedule: daily
on_failure: audit
action:
  type: api
  path: /health
`;
    const config = parseAutomationYaml(yaml, "audit.yml");
    expect(config).not.toBeNull();
    expect(config!.on_failure).toBe("audit");
  });

  test("rejects missing schedule", () => {
    const yaml = `
action:
  type: api
  path: /health
`;
    expect(parseAutomationYaml(yaml, "no-schedule.yml")).toBeNull();
  });

  test("rejects empty schedule", () => {
    const yaml = `
schedule: ""
action:
  type: api
  path: /health
`;
    expect(parseAutomationYaml(yaml, "empty-schedule.yml")).toBeNull();
  });

  test("rejects missing action", () => {
    const yaml = `
schedule: daily
`;
    expect(parseAutomationYaml(yaml, "no-action.yml")).toBeNull();
  });

  test("rejects invalid action type", () => {
    const yaml = `
schedule: daily
action:
  type: webhook
  url: http://example.com
`;
    expect(parseAutomationYaml(yaml, "bad-type.yml")).toBeNull();
  });

  test("rejects api action without path", () => {
    const yaml = `
schedule: daily
action:
  type: api
  method: GET
`;
    expect(parseAutomationYaml(yaml, "api-no-path.yml")).toBeNull();
  });

  test("rejects http action without url", () => {
    const yaml = `
schedule: daily
action:
  type: http
  method: GET
`;
    expect(parseAutomationYaml(yaml, "http-no-url.yml")).toBeNull();
  });

  test("rejects shell action without command", () => {
    const yaml = `
schedule: daily
action:
  type: shell
`;
    expect(parseAutomationYaml(yaml, "shell-no-cmd.yml")).toBeNull();
  });

  test("rejects shell action with empty command array", () => {
    const yaml = `
schedule: daily
action:
  type: shell
  command: []
`;
    expect(parseAutomationYaml(yaml, "shell-empty-cmd.yml")).toBeNull();
  });

  test("rejects invalid YAML syntax", () => {
    const yaml = `schedule: [invalid: yaml: :::`;
    expect(parseAutomationYaml(yaml, "bad-yaml.yml")).toBeNull();
  });

  test("rejects non-object YAML (scalar)", () => {
    expect(parseAutomationYaml("just a string", "scalar.yml")).toBeNull();
  });

  test("preserves custom timezone", () => {
    const yaml = `
schedule: daily
timezone: America/New_York
action:
  type: api
  path: /health
`;
    const config = parseAutomationYaml(yaml, "tz.yml");
    expect(config!.timezone).toBe("America/New_York");
  });

  test("preserves custom headers", () => {
    const yaml = `
schedule: daily
action:
  type: http
  method: POST
  url: http://example.com/hook
  headers:
    Authorization: "Bearer token123"
    X-Custom: "value"
`;
    const config = parseAutomationYaml(yaml, "headers.yml");
    expect(config!.action.headers).toEqual({
      Authorization: "Bearer token123",
      "X-Custom": "value"
    });
  });

  test("parses valid assistant automation with content only", () => {
    const yaml = `
schedule: daily-8am
action:
  type: assistant
  content: Good morning. Summarize system health and open tasks.
`;
    const config = parseAutomationYaml(yaml, "assistant-prompt.yml");
    expect(config).not.toBeNull();
    expect(config!.action.type).toBe("assistant");
    expect(config!.action.content).toBe(
      "Good morning. Summarize system health and open tasks."
    );
    expect(config!.action.agent).toBeUndefined();
    expect(config!.action.timeout).toBe(120_000);
    expect(config!.name).toBe("assistant-prompt");
  });

  test("parses assistant automation with optional agent", () => {
    const yaml = `
name: Daily Report
description: Ask the assistant for a daily report
schedule: daily-8am
action:
  type: assistant
  content: Generate a daily system report.
  agent: reporter
`;
    const config = parseAutomationYaml(yaml, "daily-report.yml");
    expect(config).not.toBeNull();
    expect(config!.name).toBe("Daily Report");
    expect(config!.description).toBe("Ask the assistant for a daily report");
    expect(config!.action.type).toBe("assistant");
    expect(config!.action.content).toBe("Generate a daily system report.");
    expect(config!.action.agent).toBe("reporter");
  });

  test("parses assistant automation with custom timeout", () => {
    const yaml = `
schedule: daily
action:
  type: assistant
  content: Run a long analysis task.
  timeout: 300000
`;
    const config = parseAutomationYaml(yaml, "long-task.yml");
    expect(config).not.toBeNull();
    expect(config!.action.timeout).toBe(300_000);
  });

  test("rejects assistant action without content", () => {
    const yaml = `
schedule: daily
action:
  type: assistant
`;
    expect(parseAutomationYaml(yaml, "no-content.yml")).toBeNull();
  });

  test("rejects assistant action with empty content", () => {
    const yaml = `
schedule: daily
action:
  type: assistant
  content: "   "
`;
    expect(parseAutomationYaml(yaml, "empty-content.yml")).toBeNull();
  });
});

// ── resolveSchedule ──────────────────────────────────────────────────

describe("resolveSchedule", () => {
  test("resolves all presets correctly", () => {
    for (const [name, cron] of Object.entries(SCHEDULE_PRESETS)) {
      expect(resolveSchedule(name)).toBe(cron);
    }
  });

  test("passes through raw cron expressions unchanged", () => {
    expect(resolveSchedule("0 2 * * *")).toBe("0 2 * * *");
    expect(resolveSchedule("*/10 * * * *")).toBe("*/10 * * * *");
  });

  test("unknown preset name passes through as cron expression", () => {
    expect(resolveSchedule("every-second")).toBe("every-second");
  });
});

// ── loadAutomations ──────────────────────────────────────────────────

describe("loadAutomations", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("loads .yml files from automations dir", () => {
    const dir = join(stateDir, "automations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "health.yml"),
      'schedule: every-5-minutes\naction:\n  type: api\n  path: /health\n'
    );
    writeFileSync(
      join(dir, "update.yml"),
      'schedule: weekly\naction:\n  type: api\n  method: POST\n  path: /admin/upgrade\n'
    );

    const configs = loadAutomations(stateDir);
    expect(configs.length).toBe(2);
  });

  test("ignores non-.yml files", () => {
    const dir = join(stateDir, "automations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "health.yml"),
      'schedule: daily\naction:\n  type: api\n  path: /health\n'
    );
    // Old crontab-style file — should be ignored
    writeFileSync(join(dir, "old-crontab"), "0 2 * * * node /work/task.sh\n");

    const configs = loadAutomations(stateDir);
    expect(configs.length).toBe(1);
    expect(configs[0].fileName).toBe("health.yml");
  });

  test("skips invalid YAML files", () => {
    const dir = join(stateDir, "automations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bad.yml"), "schedule: [invalid: yaml: :::");
    writeFileSync(
      join(dir, "good.yml"),
      'schedule: daily\naction:\n  type: api\n  path: /health\n'
    );

    const configs = loadAutomations(stateDir);
    expect(configs.length).toBe(1);
    expect(configs[0].fileName).toBe("good.yml");
  });

  test("returns empty array when dir does not exist", () => {
    const configs = loadAutomations(join(stateDir, "nonexistent"));
    expect(configs.length).toBe(0);
  });

  test("returns empty array when automations dir is empty", () => {
    mkdirSync(join(stateDir, "automations"), { recursive: true });
    const configs = loadAutomations(stateDir);
    expect(configs.length).toBe(0);
  });
});

// ── Scheduler lifecycle ─────────────────────────────────────────────

describe("scheduler lifecycle", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTempDir();
    stopScheduler(); // ensure clean state
  });

  afterEach(() => {
    stopScheduler();
    rmSync(stateDir, { recursive: true, force: true });
  });

  test("startScheduler creates jobs for enabled automations", () => {
    const dir = join(stateDir, "automations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "health.yml"),
      'schedule: every-5-minutes\naction:\n  type: api\n  path: /health\n'
    );
    writeFileSync(
      join(dir, "disabled.yml"),
      'schedule: daily\nenabled: false\naction:\n  type: api\n  path: /health\n'
    );

    startScheduler(stateDir, "test-token");
    const status = getSchedulerStatus();
    expect(status.jobCount).toBe(1);
    expect(status.jobs[0].name).toBe("health");
    expect(status.jobs[0].running).toBe(true);
  });

  test("stopScheduler clears all jobs", () => {
    const dir = join(stateDir, "automations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "health.yml"),
      'schedule: every-5-minutes\naction:\n  type: api\n  path: /health\n'
    );

    startScheduler(stateDir, "test-token");
    expect(getSchedulerStatus().jobCount).toBe(1);

    stopScheduler();
    expect(getSchedulerStatus().jobCount).toBe(0);
  });

  test("getSchedulerStatus returns empty when no jobs", () => {
    const status = getSchedulerStatus();
    expect(status.jobCount).toBe(0);
    expect(status.jobs).toEqual([]);
  });

  test("startScheduler handles empty automations dir gracefully", () => {
    mkdirSync(join(stateDir, "automations"), { recursive: true });
    startScheduler(stateDir, "test-token");
    expect(getSchedulerStatus().jobCount).toBe(0);
  });

  test("startScheduler handles missing automations dir gracefully", () => {
    startScheduler(stateDir, "test-token");
    expect(getSchedulerStatus().jobCount).toBe(0);
  });
});

// ── executeAction: assistant ─────────────────────────────────────────

describe("executeAction assistant", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("rejects invalid session ID from assistant", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "bad id with spaces" }), { status: 200 })
    );

    await expect(
      executeAction(
        { type: "assistant", content: "hello", timeout: 5000 },
        "test-token"
      )
    ).rejects.toThrow("Invalid session ID from assistant");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("rejects session ID with path traversal characters", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "../admin/evil" }), { status: 200 })
    );

    await expect(
      executeAction(
        { type: "assistant", content: "hello", timeout: 5000 },
        "test-token"
      )
    ).rejects.toThrow("Invalid session ID from assistant");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("completes two-step flow with valid session ID", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "session_abc-123" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ info: {}, parts: [{ type: "text", text: "done" }] }),
          { status: 200 }
        )
      );

    await executeAction(
      { type: "assistant", content: "summarize health", timeout: 5000 },
      "test-token"
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Step 1: session creation
    const [sessionUrl, sessionOpts] = fetchSpy.mock.calls[0];
    expect(sessionUrl).toContain("/session");
    expect(JSON.parse(sessionOpts!.body as string)).toHaveProperty("title");
    // Step 2: message send
    const [messageUrl, messageOpts] = fetchSpy.mock.calls[1];
    expect(messageUrl).toContain("/session/session_abc-123/message");
    const body = JSON.parse(messageOpts!.body as string);
    expect(body.parts[0].text).toBe("summarize health");
  });

  test("sends no auth header when OPENCODE_SERVER_PASSWORD is unset", async () => {
    const prevPassword = process.env.OPENCODE_SERVER_PASSWORD;
    delete process.env.OPENCODE_SERVER_PASSWORD;

    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: "sess1" }), { status: 200 })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ info: {}, parts: [] }),
            { status: 200 }
          )
        );

      await executeAction(
        { type: "assistant", content: "hello", timeout: 5000 },
        "test-token"
      );

      const headers = fetchSpy.mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers["authorization"]).toBeUndefined();
    } finally {
      if (prevPassword !== undefined) {
        process.env.OPENCODE_SERVER_PASSWORD = prevPassword;
      }
    }
  });

  test("throws on session creation failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("service unavailable", { status: 503 })
    );

    await expect(
      executeAction(
        { type: "assistant", content: "hello", timeout: 5000 },
        "test-token"
      )
    ).rejects.toThrow("OpenCode POST /session 503");
  });

  test("throws on message send failure", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "sess1" }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response("inference timeout", { status: 504 })
      );

    await expect(
      executeAction(
        { type: "assistant", content: "hello", timeout: 5000 },
        "test-token"
      )
    ).rejects.toThrow("OpenCode POST /session/sess1/message 504");
  });
});

// ── executeAction integration: http action with real HTTP server ─────

describe("executeAction http integration", () => {
  let server: Server;
  let serverPort: number;
  let receivedRequests: { method: string; url: string; body: string; headers: Record<string, string | string[] | undefined> }[];

  beforeEach(async () => {
    receivedRequests = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        receivedRequests.push({
          method: req.method ?? "",
          url: req.url ?? "",
          body,
          headers: req.headers as Record<string, string | string[] | undefined>
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });

    // Listen on a random available port
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    serverPort = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  test("http GET action hits the target server", async () => {
    await executeAction(
      {
        type: "http",
        method: "GET",
        url: `http://127.0.0.1:${serverPort}/test-endpoint`,
        timeout: 5000
      },
      "unused-token"
    );

    expect(receivedRequests.length).toBe(1);
    expect(receivedRequests[0].method).toBe("GET");
    expect(receivedRequests[0].url).toBe("/test-endpoint");
  });

  test("http POST action sends body and custom headers", async () => {
    await executeAction(
      {
        type: "http",
        method: "POST",
        url: `http://127.0.0.1:${serverPort}/webhook`,
        body: { message: "hello from automation" },
        headers: { "x-custom-header": "test-value" },
        timeout: 5000
      },
      "unused-token"
    );

    expect(receivedRequests.length).toBe(1);
    expect(receivedRequests[0].method).toBe("POST");
    expect(receivedRequests[0].url).toBe("/webhook");
    expect(JSON.parse(receivedRequests[0].body)).toEqual({ message: "hello from automation" });
    expect(receivedRequests[0].headers["x-custom-header"]).toBe("test-value");
    expect(receivedRequests[0].headers["content-type"]).toBe("application/json");
  });

  test("http action throws on non-2xx response", async () => {
    // Replace the server with one that returns 500
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    server = createServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal Server Error");
    });
    await new Promise<void>((resolve) => {
      server.listen(serverPort, "127.0.0.1", () => resolve());
    });

    await expect(
      executeAction(
        {
          type: "http",
          method: "GET",
          url: `http://127.0.0.1:${serverPort}/fail`,
          timeout: 5000
        },
        "unused-token"
      )
    ).rejects.toThrow("HTTP 500");
  });
});

// ── Scheduler fires cron and records execution log ───────────────────

describe("scheduler cron firing", () => {
  let stateDir: string;
  let server: Server;
  let serverPort: number;
  let hitCount: number;

  beforeEach(async () => {
    stateDir = makeTempDir();
    hitCount = 0;
    stopScheduler();

    server = createServer((_req, res) => {
      hitCount++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    serverPort = typeof addr === "object" && addr !== null ? addr.port : 0;
  });

  afterEach(async () => {
    stopScheduler();
    rmSync(stateDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  test("scheduler fires http automation and records execution log", async () => {
    const dir = join(stateDir, "automations");
    mkdirSync(dir, { recursive: true });

    // Use a per-second cron pattern so it fires within 2 seconds
    writeFileSync(
      join(dir, "e2e-probe.yml"),
      [
        "name: E2E Probe",
        "description: Integration test automation",
        "schedule: '* * * * * *'",  // every second (Croner supports seconds)
        "action:",
        "  type: http",
        "  method: GET",
        `  url: http://127.0.0.1:${serverPort}/scheduler-probe`,
        "  timeout: 5000"
      ].join("\n")
    );

    startScheduler(stateDir, "test-token");

    const status = getSchedulerStatus();
    expect(status.jobCount).toBe(1);
    expect(status.jobs[0].name).toBe("E2E Probe");
    expect(status.jobs[0].running).toBe(true);

    // Wait for the cron to fire (up to 5 seconds, polling every 200ms)
    const deadline = Date.now() + 5_000;
    while (hitCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(hitCount).toBeGreaterThanOrEqual(1);

    // Verify execution log was recorded
    const logs = getExecutionLog("e2e-probe.yml");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].ok).toBe(true);
    expect(typeof logs[0].durationMs).toBe("number");
    expect(typeof logs[0].at).toBe("string");
  }, 10_000);

  test("scheduler records failure in execution log when action fails", async () => {
    // Replace server with one that returns 500
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    server = createServer((_req, res) => {
      hitCount++;
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("Internal Server Error");
    });
    await new Promise<void>((resolve) => {
      server.listen(serverPort, "127.0.0.1", () => resolve());
    });

    const dir = join(stateDir, "automations");
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, "failing-probe.yml"),
      [
        "name: Failing Probe",
        "schedule: '* * * * * *'",
        "action:",
        "  type: http",
        "  method: GET",
        `  url: http://127.0.0.1:${serverPort}/will-fail`,
        "  timeout: 5000"
      ].join("\n")
    );

    startScheduler(stateDir, "test-token");

    // Wait for the cron to fire
    const deadline = Date.now() + 5_000;
    while (hitCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(hitCount).toBeGreaterThanOrEqual(1);

    // Verify failure was recorded in execution log
    const logs = getExecutionLog("failing-probe.yml");
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0].ok).toBe(false);
    expect(logs[0].error).toContain("HTTP 500");
  }, 10_000);
});
