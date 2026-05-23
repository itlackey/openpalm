import { describe, it, expect } from "bun:test";
import { parsePsOutput } from "../src/tools/compose-ps.ts";

describe("parsePsOutput", () => {
  it("parses NDJSON output (newer compose format)", () => {
    const ndjson = [
      '{"Name":"openpalm-guardian-1","State":"running","Status":"Up 5 minutes"}',
      '{"Name":"openpalm-assistant-1","State":"running","Status":"Up 5 minutes"}',
    ].join("\n");
    const parsed = parsePsOutput(ndjson);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].Name).toBe("openpalm-guardian-1");
    expect(parsed[1].State).toBe("running");
  });

  it("parses JSON array output (older compose format)", () => {
    const arr = JSON.stringify([
      { Name: "openpalm-guardian-1", State: "running" },
      { Name: "openpalm-assistant-1", State: "exited" },
    ]);
    const parsed = parsePsOutput(arr);
    expect(parsed).toHaveLength(2);
    expect(parsed[1].State).toBe("exited");
  });

  it("returns empty array on empty input", () => {
    expect(parsePsOutput("")).toEqual([]);
    expect(parsePsOutput("   \n\n  ")).toEqual([]);
  });

  it("skips malformed lines silently in NDJSON mode", () => {
    const mixed = [
      '{"Name":"ok"}',
      'NOT JSON',
      '{"Name":"ok2"}',
    ].join("\n");
    const parsed = parsePsOutput(mixed);
    expect(parsed).toHaveLength(2);
    expect(parsed.map((p) => p.Name)).toEqual(["ok", "ok2"]);
  });

  it("returns empty array on malformed top-level JSON array", () => {
    expect(parsePsOutput("[not, json")).toEqual([]);
  });
});
