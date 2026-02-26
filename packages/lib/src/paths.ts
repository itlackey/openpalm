import type { XDGPaths } from "./types.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

function resolveXDGDir(
  override: string | undefined, xdgBase: string | undefined, winSuffix: string, unixDefault: string
): string {
  if (override) return override;
  if (xdgBase) return join(xdgBase, "openpalm");
  const isWindows = process.platform === "win32";
  if (isWindows) {
    const localAppData = Bun.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    return join(localAppData, "OpenPalm", winSuffix);
  }
  return join(homedir(), unixDefault);
}

export function resolveXDGPaths(): XDGPaths {
  return {
    data:   resolveXDGDir(Bun.env.OPENPALM_DATA_HOME,   Bun.env.XDG_DATA_HOME,   "data",   ".local/share/openpalm"),
    config: resolveXDGDir(Bun.env.OPENPALM_CONFIG_HOME,  Bun.env.XDG_CONFIG_HOME,  "config", ".config/openpalm"),
    state:  resolveXDGDir(Bun.env.OPENPALM_STATE_HOME,   Bun.env.XDG_STATE_HOME,   "state",  ".local/state/openpalm"),
  };
}

export async function createDirectoryTree(xdg: XDGPaths): Promise<void> {
  const dataDirs = ["postgres", "qdrant", "openmemory", "assistant", "admin"];
  for (const dir of dataDirs) await mkdir(join(xdg.data, dir), { recursive: true });

  await mkdir(xdg.config, { recursive: true });

  const stateDirs = [
    "admin", "gateway", "postgres", "qdrant",
    "openmemory", "assistant", "caddy/config", "caddy/data",
  ];
  for (const dir of stateDirs) await mkdir(join(xdg.state, dir), { recursive: true });

  await mkdir(resolveWorkHome(), { recursive: true });
}

export function resolveWorkHome(): string {
  return Bun.env.OPENPALM_WORK_HOME || join(homedir(), "openpalm");
}
