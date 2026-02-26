import { describe, expect, it } from "bun:test";
import { parseCliArgs } from "./main.ts";

describe("parseCliArgs", () => {
  it("supports --flag=value syntax", () => {
    const parsed = parseCliArgs(["--port=8080"]);
    expect(parsed.values.port).toBe("8080");
  });

  it("supports -- separator for positional args", () => {
    const parsed = parseCliArgs(["--port", "8080", "--", "service-a", "service-b"]);
    expect(parsed.values.port).toBe("8080");
    expect(parsed.positionals).toEqual(["service-a", "service-b"]);
  });

  it("parses boolean flags deterministically", () => {
    const parsed = parseCliArgs(["--force", "svc"]);
    expect(parsed.values.force).toBe(true);
    expect(parsed.positionals).toEqual(["svc"]);
  });
});
