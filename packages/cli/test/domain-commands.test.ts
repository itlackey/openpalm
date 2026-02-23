import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC_DIR = join(import.meta.dir, "../src/commands");
const serviceSource = readFileSync(join(SRC_DIR, "service.ts"), "utf-8");
const channelSource = readFileSync(join(SRC_DIR, "channel.ts"), "utf-8");
const automationSource = readFileSync(join(SRC_DIR, "automation.ts"), "utf-8");

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

  it("service command maps subcommands to admin command types", () => {
    expect(serviceSource).toContain('"service.up"');
    expect(serviceSource).toContain('"service.stop"');
    expect(serviceSource).toContain('"service.restart"');
    expect(serviceSource).toContain('"service.update"');
    expect(serviceSource).toContain('"service.logs"');
    expect(serviceSource).toContain('"service.status"');
  });

  it("channel add supports yaml file or inline yaml", () => {
    expect(channelSource).toContain('getArg(args, "yaml")');
    expect(channelSource).toContain('getArg(args, "file")');
    expect(channelSource).toContain('"snippet.import"');
    expect(channelSource).toContain('section: "channel"');
  });

  it("automation run maps to automation trigger command", () => {
    expect(automationSource).toContain('subcommand !== "run" && subcommand !== "trigger"');
    expect(automationSource).toContain('"automation.trigger"');
  });
});
