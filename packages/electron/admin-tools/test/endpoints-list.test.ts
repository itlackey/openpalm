import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEndpointsFile, endpointsPath } from "../src/tools/endpoints-list.ts";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "openpalm-admin-tools-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("endpointsPath", () => {
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${OP_HOME} documents the path template in the test name, not an interpolation.
  it("resolves to ${OP_HOME}/config/endpoints.json", () => {
    expect(endpointsPath("/some/home")).toBe("/some/home/config/endpoints.json");
  });
});

describe("readEndpointsFile", () => {
  it("returns empty file when path does not exist", () => {
    const result = readEndpointsFile(join(home, "missing.json"));
    expect(result.activeId).toBeNull();
    expect(result.endpoints).toEqual([]);
  });

  it("parses a valid endpoints file", () => {
    const path = join(home, "endpoints.json");
    writeFileSync(path, JSON.stringify({
      activeId: "abc",
      endpoints: [{ id: "abc", label: "Remote", url: "http://10.0.0.5:3800", password: "secret" }],
    }));
    const result = readEndpointsFile(path);
    expect(result.activeId).toBe("abc");
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0].label).toBe("Remote");
  });

  it("recovers gracefully from malformed JSON", () => {
    const path = join(home, "garbage.json");
    writeFileSync(path, "{this is not json");
    const result = readEndpointsFile(path);
    expect(result.activeId).toBeNull();
    expect(result.endpoints).toEqual([]);
  });

  it("normalizes activeId to null when malformed", () => {
    const path = join(home, "bad-active.json");
    writeFileSync(path, JSON.stringify({ activeId: 42, endpoints: [] }));
    const result = readEndpointsFile(path);
    expect(result.activeId).toBeNull();
  });
});

describe("contract: tool output never includes passwords", () => {
  it("the tool definition strips password from each endpoint", async () => {
    // Stage a fake endpoints.json under a temp OP_HOME and call the tool.
    const configDir = join(home, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "endpoints.json"),
      JSON.stringify({
        activeId: "x",
        endpoints: [{ id: "x", label: "Remote", url: "http://10/", password: "DONT-LEAK-ME" }],
      }),
    );
    const savedHome = process.env.OP_HOME;
    process.env.OP_HOME = home;
    try {
      const tool = (await import("../src/tools/endpoints-list.ts")).default;
      const result = await tool.execute({}, {} as Parameters<typeof tool.execute>[1]);
      const text = typeof result === "string" ? result : result.output;
      expect(text).toContain("Remote");
      expect(text).not.toContain("DONT-LEAK-ME");
    } finally {
      if (savedHome === undefined) delete process.env.OP_HOME;
      else process.env.OP_HOME = savedHome;
    }
  });
});
