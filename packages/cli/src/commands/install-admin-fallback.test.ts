import { describe, expect, it } from "bun:test";

const installFile = new URL("./install.ts", import.meta.url).pathname;
const composeFile = new URL(
  "../../../../packages/lib/src/embedded/state/docker-compose.yml",
  import.meta.url
).pathname;

describe("ISSUE-11 — Admin UI accessible if Caddy fails", () => {
  it("minimal compose maps admin port 8100 directly", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("127.0.0.1:8100:8100");
  });

  it("health check falls back to direct admin port", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("adminDirectUrl");
    expect(content).toContain("http://localhost:8100");
    // Fallback logic: try Caddy first, then direct
    expect(content).toContain("healthDirectUrl");
  });

  it("failure output includes direct admin URL", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("try the direct admin URL");
    expect(content).toContain("http://localhost:8100");
  });

  it("success output includes direct admin URL as fallback", async () => {
    const content = await Bun.file(installFile).text();
    expect(content).toContain("Direct admin");
    expect(content).toContain("if port 80 is blocked");
  });

  it("full stack compose template has admin port mapping", async () => {
    const content = await Bun.file(composeFile).text();
    expect(content).toContain("127.0.0.1:8100:8100");
  });
});
