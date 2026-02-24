import { describe, expect, it } from "bun:test";

const composeFile = new URL("./docker-compose.yml", import.meta.url).pathname;

describe("ISSUE-15 — OpenMemory images version-pinned", () => {
  it("openmemory-mcp image is pinned by digest", async () => {
    const content = await Bun.file(composeFile).text();
    // The image tag should include @sha256: for digest pinning
    expect(content).toMatch(/mem0\/openmemory-mcp:.*@sha256:/);
  });

  it("openmemory-ui image is pinned by digest", async () => {
    const content = await Bun.file(composeFile).text();
    expect(content).toMatch(/mem0\/openmemory-ui:.*@sha256:/);
  });

  it("pinned images have a comment explaining the rationale", async () => {
    const content = await Bun.file(composeFile).text();
    expect(content).toContain("Pinned by digest");
    expect(content).toContain("update deliberately after testing");
  });
});
