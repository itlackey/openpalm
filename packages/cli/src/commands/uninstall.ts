import { rm, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { UninstallOptions, ContainerPlatform } from "../types.ts";
import type { ComposeConfig } from "@openpalm/lib/types.ts";
import { composeDown } from "@openpalm/lib/compose.ts";
import { readEnvFile } from "@openpalm/lib/env.ts";
import { resolveXDGPaths, resolveWorkHome } from "@openpalm/lib/paths.ts";
import { resolveComposeBin, detectRuntime, detectOS } from "@openpalm/lib/runtime.ts";
import { log, info, warn, error, bold, green, red, yellow, dim, confirm } from "@openpalm/lib/ui.ts";

export async function uninstall(options: UninstallOptions): Promise<void> {
  // 1. Resolve XDG paths
  const xdg = resolveXDGPaths();

  // 2. Try to read .env from state home, falling back to CWD .env
  let env: Record<string, string> = {};
  const stateEnvPath = join(xdg.state, ".env");
  try {
    env = await readEnvFile(stateEnvPath);
  } catch {
    try {
      env = await readEnvFile(resolve(process.cwd(), ".env"));
    } catch {
      // No env file found, continue with empty env
    }
  }

  // 3. Determine container platform
  let platform: ContainerPlatform | null = null;
  if (options.runtime) {
    platform = options.runtime;
  } else if (env.OPENPALM_CONTAINER_PLATFORM) {
    platform = env.OPENPALM_CONTAINER_PLATFORM as ContainerPlatform;
  } else {
    platform = await detectRuntime(detectOS());
  }

  // 4. Resolve compose bin/subcommand if platform found
  let composeBin: { bin: string; subcommand: string } | null = null;
  if (platform) {
    composeBin = resolveComposeBin(platform);
  }

  // 5. Print planned actions summary
  log("");
  log(bold("Uninstall Summary:"));
  log(`Runtime platform: ${platform || "not detected"}`);
  log("Stop/remove containers: yes");
  log(`Remove images: ${options.removeImages ? "yes" : "no"}`);
  log(`Remove all data/config/state: ${options.removeAll ? "yes" : "no"}`);
  log(`Remove CLI binary: ${options.removeBinary ? "yes" : "no"}`);
  log("");
  log(`Data directory: ${xdg.data}`);
  log(`Config directory: ${xdg.config}`);
  log(`State directory: ${xdg.state}`);
  log("");

  // 6. Prompt for confirmation if not --yes
  if (!options.yes) {
    const shouldContinue = await confirm("Continue?");
    if (!shouldContinue) {
      log("Aborted.");
      return;
    }
  }

  // 7. Stop and remove containers if compose is available
  const composeFilePath = join(xdg.state, "docker-compose.yml");
  if (composeBin && platform) {
    try {
      // Check if compose file exists by attempting to read env (simple existence check)
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
      // 8. Compose file not found or other error
      warn("Compose runtime or file not found; skipping container shutdown.");
    }
  } else {
    // 8. No platform/compose bin detected
    warn("Compose runtime or file not found; skipping container shutdown.");
  }

  // 9. Remove all data/config/state if requested
  if (options.removeAll) {
    try {
      await rm(xdg.data, { recursive: true, force: true });
    } catch {
      // Directory may not exist, continue
    }

    try {
      await rm(xdg.config, { recursive: true, force: true });
    } catch {
      // Directory may not exist, continue
    }

    try {
      await rm(xdg.state, { recursive: true, force: true });
    } catch {
      // Directory may not exist, continue
    }

    try {
      await unlink(resolve(process.cwd(), ".env"));
    } catch {
      // .env may not exist in CWD, continue
    }

    info("Removed OpenPalm data/config/state and local .env.");
  }

  // 10. Remove CLI binary if requested
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
      // Binary may not exist at this path (installed elsewhere)
      warn(`Could not remove binary at ${dim(binaryPath)} — it may have been installed elsewhere.`);
    }

    // On Windows, also clean up PATH entry
    if (os === "windows") {
      try {
        const localAppData = Bun.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
        const installDir = join(localAppData, "OpenPalm");
        const proc = Bun.spawn(["powershell", "-NoProfile", "-Command",
          `$p = [Environment]::GetEnvironmentVariable('Path','User'); ` +
          `$p = ($p.Split(';') | Where-Object { $_ -ne '${installDir.replace(/'/g, "''")}' }) -join ';'; ` +
          `[Environment]::SetEnvironmentVariable('Path', $p, 'User')`
        ], { stdout: "ignore", stderr: "ignore" });
        await proc.exited;
        if (proc.exitCode === 0) {
          info("Removed install directory from user PATH.");
        }
      } catch {
        // Non-critical — user can remove manually
      }
    }
  }

  // 11. Notify about work directory
  const workDir = resolveWorkHome();
  log("");
  info(`Note: ${dim(workDir)} (assistant working directory) was not removed.`);
  info("  Delete it manually if you no longer need it.");

  // 11. Success message
  info(green("Uninstall complete."));
}
