import type { XDGPaths } from "./types.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

export function resolveXDGPaths(): XDGPaths {
  const home = homedir();
  const data =
    Bun.env.OPENPALM_DATA_HOME ||
    (Bun.env.XDG_DATA_HOME ? join(Bun.env.XDG_DATA_HOME, "openpalm") : undefined) ||
    join(home, ".local", "share", "openpalm");

  const config =
    Bun.env.OPENPALM_CONFIG_HOME ||
    (Bun.env.XDG_CONFIG_HOME ? join(Bun.env.XDG_CONFIG_HOME, "openpalm") : undefined) ||
    join(home, ".config", "openpalm");

  const state =
    Bun.env.OPENPALM_STATE_HOME ||
    (Bun.env.XDG_STATE_HOME ? join(Bun.env.XDG_STATE_HOME, "openpalm") : undefined) ||
    join(home, ".local", "state", "openpalm");

  return { data, config, state };
}

export async function createDirectoryTree(xdg: XDGPaths): Promise<void> {
  const dataDirs = ["postgres", "qdrant", "openmemory", "opencode", "admin"];
  for (const dir of dataDirs) await mkdir(join(xdg.data, dir), { recursive: true });

  await mkdir(xdg.config, { recursive: true });

  const stateDirs = [
    "gateway",
    "rendered",
    "rendered/caddy",
    "rendered/caddy/snippets",
    "rendered/env",
    "caddy/config",
    "caddy/data",
    "logs",
    "tmp",
  ];
  for (const dir of stateDirs) await mkdir(join(xdg.state, dir), { recursive: true });

  await mkdir(join(homedir(), "openpalm"), { recursive: true });
}
