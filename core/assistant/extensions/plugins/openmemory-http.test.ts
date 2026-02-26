import { describe, expect, it } from "bun:test";
import {
  containsSecret,
  isSaveWorthy,
  loadConfig,
  formatRecallBlock,
  OpenMemoryClient,
} from "../lib/openmemory-client.ts";
import type { MemoryHit } from "../lib/openmemory-client.ts";

// ---------------------------------------------------------------------------
// Secret detection
// ---------------------------------------------------------------------------

describe("containsSecret", () => {
  it("detects API keys", () => {
    expect(containsSecret("my api_key is abc123")).toBe(true);
    expect(containsSecret("the api-key: xyz")).toBe(true);
  });

  it("detects tokens and passwords", () => {
    expect(containsSecret("token=abc")).toBe(true);
    expect(containsSecret("password: hunter2")).toBe(true);
  });

  it("detects private keys", () => {
    expect(containsSecret("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    expect(containsSecret("private_key: ...")).toBe(true);
  });

  it("detects GitHub PATs and OpenAI keys", () => {
    expect(containsSecret("ghp_ABCdefGHIjklMNOpqrSTUvwxYZ0123456789")).toBe(true);
    expect(containsSecret("sk-abc123def456ghi789jkl")).toBe(true);
  });

  it("allows safe text", () => {
    expect(containsSecret("The user prefers dark mode.")).toBe(false);
    expect(containsSecret("Project deadline is Friday.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Write-back classifier
// ---------------------------------------------------------------------------

describe("isSaveWorthy", () => {
  it("returns true for explicit categories", () => {
    expect(isSaveWorthy("anything", ["preference"])).toBe(true);
    expect(isSaveWorthy("anything", ["fact"])).toBe(true);
    expect(isSaveWorthy("anything", ["todo"])).toBe(true);
    expect(isSaveWorthy("anything", ["decision"])).toBe(true);
    expect(isSaveWorthy("anything", ["project_state"])).toBe(true);
  });

  it("returns true for keyword signals", () => {
    expect(isSaveWorthy("remember to buy milk")).toBe(true);
    expect(isSaveWorthy("My preference is dark mode")).toBe(true);
    expect(isSaveWorthy("TODO: fix the build")).toBe(true);
    expect(isSaveWorthy("This is important context")).toBe(true);
    expect(isSaveWorthy("Always use UTC timestamps")).toBe(true);
    expect(isSaveWorthy("Never deploy on Friday")).toBe(true);
    expect(isSaveWorthy("The decision was to use Postgres")).toBe(true);
    expect(isSaveWorthy("Current project state is alpha")).toBe(true);
  });

  it("returns false for generic chatter", () => {
    expect(isSaveWorthy("Hello, how are you?")).toBe(false);
    expect(isSaveWorthy("Sure, I can help with that.")).toBe(false);
    expect(isSaveWorthy("Here is the code you asked for.")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Recall block formatting + limits
// ---------------------------------------------------------------------------

describe("formatRecallBlock", () => {
  const hits: MemoryHit[] = [
    { id: "m1", text: "User prefers dark mode" },
    { id: "m2", text: "Project deadline is Friday" },
    { id: "m3", text: "Always use UTC timestamps" },
  ];

  it("formats memories into a delimited block", () => {
    const block = formatRecallBlock(hits, 5000);
    expect(block).toContain("<recalled_memories>");
    expect(block).toContain("</recalled_memories>");
    expect(block).toContain("[m1]");
    expect(block).toContain("[m2]");
    expect(block).toContain("[m3]");
    expect(block).toContain("User prefers dark mode");
  });

  it("returns empty string for no hits", () => {
    expect(formatRecallBlock([], 5000)).toBe("");
  });

  it("truncates when exceeding maxChars", () => {
    const block = formatRecallBlock(hits, 80);
    expect(block).toContain("<recalled_memories>");
    expect(block).toContain("truncated");
    // Should not contain all three memories
    expect(block).not.toContain("[m3]");
  });
});

// ---------------------------------------------------------------------------
// Config loading from env
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
  it("returns defaults when no env vars are set", () => {
    const saved = { ...process.env };
    delete process.env.OPENMEMORY_BASE_URL;
    delete process.env.OPENMEMORY_API_KEY;
    delete process.env.OPENPALM_MEMORY_MODE;
    delete process.env.RECALL_LIMIT;
    delete process.env.RECALL_MAX_CHARS;
    delete process.env.WRITEBACK_ENABLED;

    try {
      const cfg = loadConfig();
      expect(cfg.baseUrl).toBe("http://openmemory:8765");
      expect(cfg.apiKey).toBe("");
      expect(cfg.mode).toBe("api");
      expect(cfg.recallLimit).toBe(5);
      expect(cfg.recallMaxChars).toBe(2000);
      expect(cfg.writebackEnabled).toBe(true);
    } finally {
      // Restore original env: delete keys we added, restore original values
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });

  it("respects custom env values", () => {
    const saved = { ...process.env };
    process.env.OPENMEMORY_BASE_URL = "http://localhost:9999";
    process.env.RECALL_LIMIT = "10";
    process.env.RECALL_MAX_CHARS = "4000";
    process.env.WRITEBACK_ENABLED = "false";

    try {
      const cfg = loadConfig();
      expect(cfg.baseUrl).toBe("http://localhost:9999");
      expect(cfg.recallLimit).toBe(10);
      expect(cfg.recallMaxChars).toBe(4000);
      expect(cfg.writebackEnabled).toBe(false);
    } finally {
      // Restore original env: delete keys we added, restore original values
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });

  it("clamps out-of-range values", () => {
    const saved = { ...process.env };
    process.env.RECALL_LIMIT = "999";
    process.env.RECALL_MAX_CHARS = "1";

    try {
      const cfg = loadConfig();
      expect(cfg.recallLimit).toBe(50);
      expect(cfg.recallMaxChars).toBe(100);
    } finally {
      // Restore original env: delete keys we added, restore original values
      for (const key of Object.keys(process.env)) {
        if (!(key in saved)) delete process.env[key];
      }
      Object.assign(process.env, saved);
    }
  });
});

// ---------------------------------------------------------------------------
// OpenMemoryClient — mock HTTP tests
// ---------------------------------------------------------------------------

describe("OpenMemoryClient", () => {
  it("queries memory and returns hits", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(
          JSON.stringify({ results: [{ id: "m1", text: "recalled fact", score: 0.9 }] }),
          { headers: { "content-type": "application/json" } }
        );
      },
    });
    try {
      const client = new OpenMemoryClient(`http://localhost:${server.port}`);
      const hits = await client.queryMemory({ query: "test" });
      expect(hits.length).toBe(1);
      expect(hits[0].id).toBe("m1");
      expect(hits[0].text).toBe("recalled fact");
    } finally {
      server.stop();
    }
  });

  it("adds memory and returns id", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(JSON.stringify({ id: "new-1" }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const client = new OpenMemoryClient(`http://localhost:${server.port}`);
      const result = await client.addMemory({ text: "store this" });
      expect(result.id).toBe("new-1");
    } finally {
      server.stop();
    }
  });

  it("throws on non-ok response", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("error", { status: 500 });
      },
    });
    try {
      const client = new OpenMemoryClient(`http://localhost:${server.port}`);
      await expect(client.queryMemory({ query: "test" })).rejects.toThrow("500");
    } finally {
      server.stop();
    }
  });

  it("sends Authorization header when API key is provided", async () => {
    let receivedAuth = "";
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        receivedAuth = req.headers.get("authorization") ?? "";
        return new Response(JSON.stringify({ results: [] }), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    try {
      const client = new OpenMemoryClient(`http://localhost:${server.port}`, "my-key");
      await client.queryMemory({ query: "test" });
      expect(receivedAuth).toBe("Bearer my-key");
    } finally {
      server.stop();
    }
  });

});

// ---------------------------------------------------------------------------
// Regression: disabled mode
// ---------------------------------------------------------------------------

describe("disabled mode", () => {
  it("plugin is disabled when OPENPALM_MEMORY_MODE is not api", () => {
    // The plugin module-level `enabled` flag is set at import time based on
    // OPENPALM_MEMORY_MODE. Since we cannot easily re-import with different
    // env in the same process, we verify the config helper instead.
    const saved = process.env.OPENPALM_MEMORY_MODE;
    process.env.OPENPALM_MEMORY_MODE = "disabled";
    try {
      const cfg = loadConfig();
      expect(cfg.mode).toBe("disabled");
      expect(cfg.mode === "api").toBe(false);
    } finally {
      if (saved !== undefined) process.env.OPENPALM_MEMORY_MODE = saved;
      else delete process.env.OPENPALM_MEMORY_MODE;
    }
  });
});
