import type { XDGPaths } from "../types.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export function resolveXDGPaths(): XDGPaths {
  const home = homedir();

  // Data directory
  const data =
    Bun.env.OPENPALM_DATA_HOME ||
    (Bun.env.XDG_DATA_HOME ? join(Bun.env.XDG_DATA_HOME, "openpalm") : undefined) ||
    join(home, ".local", "share", "openpalm");

  // Config directory
  const config =
    Bun.env.OPENPALM_CONFIG_HOME ||
    (Bun.env.XDG_CONFIG_HOME ? join(Bun.env.XDG_CONFIG_HOME, "openpalm") : undefined) ||
    join(home, ".config", "openpalm");

  // State directory
  const state =
    Bun.env.OPENPALM_STATE_HOME ||
    (Bun.env.XDG_STATE_HOME ? join(Bun.env.XDG_STATE_HOME, "openpalm") : undefined) ||
    join(home, ".local", "state", "openpalm");

  return { data, config, state };
}

export async function createDirectoryTree(xdg: XDGPaths): Promise<void> {
  // Data subdirectories
  const dataDirs = ["postgres", "qdrant", "openmemory", "shared", "caddy", "admin"];
  for (const dir of dataDirs) {
    await mkdir(join(xdg.data, dir), { recursive: true });
  }

  // Config subdirectories
  const configDirs = ["opencode-core", "caddy", "channels", "cron", "secrets", "secrets/gateway", "secrets/channels"];
  for (const dir of configDirs) {
    await mkdir(join(xdg.config, dir), { recursive: true });
  }

  // State subdirectories
  const stateDirs = ["opencode-core", "gateway", "caddy", "workspace", "observability", "backups"];
  for (const dir of stateDirs) {
    await mkdir(join(xdg.state, dir), { recursive: true });
  }
}
