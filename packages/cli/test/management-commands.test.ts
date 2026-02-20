import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Helper function to read source code files
function readSourceFile(filename: string): string {
  const path = join("/home/user/openpalm/packages/cli/src/commands", filename);
  return readFileSync(path, "utf-8");
}

function readLibFile(filename: string): string {
  const path = join("/home/user/openpalm/packages/cli/src/lib", filename);
  return readFileSync(path, "utf-8");
}

describe("shared loadComposeConfig module", () => {
  const configSource = readLibFile("config.ts");

  it("reads compose config from XDG state home", () => {
    expect(configSource).toContain("resolveXDGPaths()");
    expect(configSource).toContain("xdg.state");
    expect(configSource).toContain('join(xdg.state, ".env")');
    expect(configSource).toContain('join(xdg.state, "docker-compose.yml")');
  });

  it("defaults to docker compose if env not set", () => {
    expect(configSource).toContain('env.OPENPALM_COMPOSE_BIN ?? "docker"');
    expect(configSource).toContain('env.OPENPALM_COMPOSE_SUBCOMMAND ?? "compose"');
  });

  it("implements loadComposeConfig with consistent structure", () => {
    expect(configSource).toContain("export async function loadComposeConfig(): Promise<ComposeConfig>");
    expect(configSource).toContain("await readEnvFile(envPath)");
    expect(configSource).toContain("bin:");
    expect(configSource).toContain("subcommand:");
    expect(configSource).toContain("envFile:");
    expect(configSource).toContain("composeFile:");
  });
});

describe("update command", () => {
  const source = readSourceFile("update.ts");

  it("imports loadComposeConfig from shared module", () => {
    expect(source).toContain('import { loadComposeConfig } from "../lib/config.ts"');
  });

  it("calls loadComposeConfig before compose operations", () => {
    expect(source).toContain("const config = await loadComposeConfig()");
  });

  it("pulls latest images before recreating", () => {
    expect(source).toContain("composePull(config)");
    expect(source).toContain("composeUp(config");
    // Verify composePull appears before composeUp in the source
    const pullIndex = source.indexOf("composePull(config)");
    const upIndex = source.indexOf("composeUp(config");
    expect(pullIndex).toBeLessThan(upIndex);
  });

  it("recreates containers with pull always", () => {
    expect(source).toContain('pull: "always"');
    expect(source).toContain("composeUp(config, undefined, { pull: \"always\" })");
  });
});

describe("start command", () => {
  const source = readSourceFile("start.ts");

  it("imports loadComposeConfig from shared module", () => {
    expect(source).toContain('import { loadComposeConfig } from "../lib/config.ts"');
  });

  it("accepts optional service names", () => {
    expect(source).toContain("services?: string[]");
    expect(source).toContain("export async function start(services?: string[])");
  });

  it("calls composeUp with service list", () => {
    expect(source).toContain("composeUp(config, services)");
  });

  it("uses compose up (not restart)", () => {
    expect(source).toContain("import { composeUp }");
    expect(source).toContain("composeUp(config");
    expect(source).not.toContain("composeRestart");
  });
});

describe("stop command", () => {
  const source = readSourceFile("stop.ts");

  it("imports loadComposeConfig from shared module", () => {
    expect(source).toContain('import { loadComposeConfig } from "../lib/config.ts"');
  });

  it("calls composeStop (not composeDown)", () => {
    expect(source).toContain("import { composeStop }");
    expect(source).toContain("composeStop(config");
    expect(source).not.toContain("composeDown");
  });

  it("accepts optional service names", () => {
    expect(source).toContain("services?: string[]");
    expect(source).toContain("composeStop(config, services)");
  });
});

describe("restart command", () => {
  const source = readSourceFile("restart.ts");

  it("imports loadComposeConfig from shared module", () => {
    expect(source).toContain('import { loadComposeConfig } from "../lib/config.ts"');
  });

  it("calls composeRestart", () => {
    expect(source).toContain("import { composeRestart }");
    expect(source).toContain("composeRestart(config, services)");
  });

  it("accepts optional service names", () => {
    expect(source).toContain("services?: string[]");
    expect(source).toContain("export async function restart(services?: string[])");
  });
});

describe("logs command", () => {
  const source = readSourceFile("logs.ts");

  it("imports loadComposeConfig from shared module", () => {
    expect(source).toContain('import { loadComposeConfig } from "../lib/config.ts"');
  });

  it("follows logs by default", () => {
    expect(source).toContain("follow: true");
  });

  it("uses tail of 50", () => {
    expect(source).toContain("tail: 50");
  });

  it("passes service filter when provided", () => {
    expect(source).toContain("composeLogs(config, services?.length ? services : undefined");
  });

  it("passes undefined services when none specified", () => {
    expect(source).toContain("services?.length ? services : undefined");
    expect(source).toContain("{ follow: true, tail: 50 }");
  });
});

describe("status command", () => {
  const source = readSourceFile("status.ts");

  it("imports loadComposeConfig from shared module", () => {
    expect(source).toContain('import { loadComposeConfig } from "../lib/config.ts"');
  });

  it("calls composePs", () => {
    expect(source).toContain("import { composePs }");
    expect(source).toContain("composePs(config)");
  });

  it("prints output to stdout", () => {
    expect(source).toContain("log(output)");
    expect(source).toContain("const output = await composePs(config)");
  });
});

describe("all management commands - shared config pattern", () => {
  const commands = ["update.ts", "start.ts", "stop.ts", "restart.ts", "logs.ts", "status.ts"];

  it("all commands import loadComposeConfig from shared module", () => {
    for (const command of commands) {
      const source = readSourceFile(command);
      expect(source).toContain('import { loadComposeConfig } from "../lib/config.ts"');
    }
  });

  it("all commands call loadComposeConfig before executing compose operations", () => {
    for (const command of commands) {
      const source = readSourceFile(command);
      expect(source).toContain("const config = await loadComposeConfig()");
    }
  });

  it("no commands duplicate loadComposeConfig inline", () => {
    for (const command of commands) {
      const source = readSourceFile(command);
      expect(source).not.toContain("async function loadComposeConfig()");
    }
  });
});
