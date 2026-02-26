import { describe, expect, it } from "bun:test";
import { parseCliArgs } from "./main.ts";

describe("parseCliArgs", () => {
  it("supports --flag=value syntax", () => {
    const parsed = parseCliArgs(["--runtime=podman", "--port=8080"]);
    expect(parsed.values.runtime).toBe("podman");
    expect(parsed.values.port).toBe("8080");
  });

  it("supports -- separator for positional args", () => {
    const parsed = parseCliArgs(["--runtime", "docker", "--", "service-a", "service-b"]);
    expect(parsed.values.runtime).toBe("docker");
    expect(parsed.positionals).toEqual(["service-a", "service-b"]);
  });

  it("parses boolean flags deterministically", () => {
    const parsed = parseCliArgs(["--no-open", "--force", "svc"]);
    expect(parsed.values["no-open"]).toBe(true);
    expect(parsed.values.force).toBe(true);
    expect(parsed.positionals).toEqual(["svc"]);
  });
});
