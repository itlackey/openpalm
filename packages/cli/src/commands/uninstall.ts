import { rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { UninstallOptions } from "../types.ts";
import type { ComposeConfig } from "@openpalm/lib/types.ts";
import { composeDown } from "@openpalm/lib/compose.ts";
import { resolveXDGPaths, resolveWorkHome } from "@openpalm/lib/paths.ts";
import { COMPOSE_BIN, detectRuntime, detectOS } from "@openpalm/lib/runtime.ts";
import { log, info, warn, bold, green, dim, confirm } from "@openpalm/lib/ui.ts";

export async function uninstall(options: UninstallOptions): Promise<void> {
  const xdg = resolveXDGPaths();
  const stateEnvPath = join(xdg.state, ".env");
  const platform = await detectRuntime();
  const composeBin = platform ? COMPOSE_BIN : null;

  log("");
  log(bold("Uninstall Summary:"));
  log("Stop/remove containers: yes");
  log(`Remove images: ${options.removeImages ? "yes" : "no"}`);
  log(`Remove all data/config/state: ${options.removeAll ? "yes" : "no"}`);
  log(`Remove CLI binary: ${options.removeBinary ? "yes" : "no"}`);
  log("");
  log(`Data directory: ${xdg.data}`);
  log(`Config directory: ${xdg.config}`);
  log(`State directory: ${xdg.state}`);
  log("");

  if (!options.yes) {
    const shouldContinue = await confirm("Continue?");
    if (!shouldContinue) {
      log("Aborted.");
      return;
    }
  }

  const composeFilePath = join(xdg.state, "docker-compose.yml");
  if (composeBin && platform) {
    try {
      await Bun.file(composeFilePath).text();
      const config: ComposeConfig = {
        bin: composeBin.bin,
        subcommand: composeBin.subcommand,
        envFile: stateEnvPath,
        composeFile: composeFilePath,
      };
      await composeDown(config, {
        removeOrphans: true,
        removeImages: options.removeImages,
      });
    } catch {
      warn("Compose runtime or file not found; skipping container shutdown.");
    }
  } else {
    warn("Docker not found; skipping container shutdown.");
  }

  if (options.removeAll) {
    try { await rm(xdg.data, { recursive: true, force: true }); } catch {}
    try { await rm(xdg.config, { recursive: true, force: true }); } catch {}
    try { await rm(xdg.state, { recursive: true, force: true }); } catch {}
    try { await unlink(resolve(process.cwd(), ".env")); } catch {}
    info("Removed OpenPalm data/config/state and local .env.");
  }

  if (options.removeBinary) {
    const os = detectOS();
    let binaryPath: string;
    if (os === "windows") {
      const localAppData = Bun.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
      binaryPath = join(localAppData, "OpenPalm", "openpalm.exe");
    } else {
      binaryPath = join(homedir(), ".local", "bin", "openpalm");
    }
    try {
      await unlink(binaryPath);
      info(`Removed CLI binary: ${binaryPath}`);
    } catch {
      warn(`Could not remove binary at ${dim(binaryPath)} — it may have been installed elsewhere.`);
    }
  }

  const workDir = resolveWorkHome();
  log("");
  info(`Note: ${dim(workDir)} (assistant working directory) was not removed.`);
  info("  Delete it manually if you no longer need it.");
  info(green("Uninstall complete."));
}
