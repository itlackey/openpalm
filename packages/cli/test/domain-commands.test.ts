import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "../src/commands");
const serviceSource = readFileSync(join(SRC_DIR, "service.ts"), "utf-8");
const channelSource = readFileSync(join(SRC_DIR, "channel.ts"), "utf-8");

describe("domain-based command source validation", () => {
  it("service command supports local fallback mode", () => {
    expect(serviceSource).toContain("adminEnvContext()");
    expect(serviceSource).toContain("if (!explicit)");
    expect(serviceSource).toContain("start(");
    expect(serviceSource).toContain("stop(");
    expect(serviceSource).toContain("restart(");
    expect(serviceSource).toContain("logs(");
    expect(serviceSource).toContain("status(");
  });

  it("service command uses REST admin client for remote mode", () => {
    expect(serviceSource).toContain("getAdminClient()");
    expect(serviceSource).toContain("client.listContainers()");
    expect(serviceSource).toContain("client.containerUp(");
    expect(serviceSource).toContain("client.containerStop(");
    expect(serviceSource).toContain("client.containerRestart(");
    expect(serviceSource).toContain("client.containerUpdate(");
    expect(serviceSource).toContain("client.serviceLogs(");
  });

  it("channel configure uses REST admin client to update stack spec", () => {
    expect(channelSource).toContain("getAdminClient()");
    expect(channelSource).toContain("client.getStackSpec()");
    expect(channelSource).toContain("client.setStackSpec(");
    expect(channelSource).toContain("client.applyStack()");
  });
});
