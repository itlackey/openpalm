import { join } from "node:path";
import { copyFile, chmod, writeFile, rm } from "node:fs/promises";
import type { InstallOptions } from "../types.ts";
import type { ComposeConfig } from "@openpalm/lib/types.ts";
import { detectOS, detectArch, detectRuntime, resolveSocketPath, resolveComposeBin, validateRuntime } from "@openpalm/lib/runtime.ts";
import { resolveXDGPaths, createDirectoryTree } from "@openpalm/lib/paths.ts";
import { upsertEnvVar } from "@openpalm/lib/env.ts";
import { generateToken } from "@openpalm/lib/tokens.ts";
import { composePull, composeUp } from "@openpalm/lib/compose.ts";
import { resolveAssets, seedConfigFiles, cleanupTempAssets } from "@openpalm/lib/assets.ts";
import { runPreflightChecks, noRuntimeGuidance, noComposeGuidance } from "@openpalm/lib/preflight.ts";
import { log, info, warn, error, bold, green, cyan, yellow, dim, spinner } from "@openpalm/lib/ui.ts";

export async function install(options: InstallOptions): Promise<void> {
  // ============================================================================
  // Phase 1: Setup infrastructure
  // ============================================================================

  log(bold("\nOpenPalm Installation\n"));

  // 1. Detect OS
  const os = detectOS();
  if (os === "unknown") {
    error("Unable to detect operating system. Installation aborted.");
    process.exit(1);
  }

  // 2. Detect arch
  const arch = detectArch();

  // 3. Detect or use overridden container runtime
  const platform = options.runtime ?? await detectRuntime(os);
  if (!platform) {
    error(noRuntimeGuidance(os));
    process.exit(1);
  }

  // 4. Resolve compose bin/subcommand
  const { bin, subcommand } = resolveComposeBin(platform);

  // 5. Run pre-flight checks (daemon running, disk space, port 80)
  const preflightWarnings = await runPreflightChecks(bin, platform);
  for (const w of preflightWarnings) {
    warn(w.message);
    if (w.detail) {
      for (const line of w.detail.split("\n")) {
        info(`  ${line}`);
      }
    }
    log("");
  }

  // Daemon not running is fatal — we can't proceed
  const daemonWarning = preflightWarnings.find((w) =>
    w.message.includes("daemon is not running")
  );
  if (daemonWarning) {
    process.exit(1);
  }

  // 6. Validate compose works
  const isValid = await validateRuntime(bin, subcommand);
  if (!isValid) {
    error(noComposeGuidance(platform));
    process.exit(1);
  }

  // 7. Print detected info
  log(bold("Detected environment:"));
  info(`  OS: ${cyan(os)}`);
  info(`  Architecture: ${cyan(arch)}`);
  info(`  Container runtime: ${cyan(platform)}`);
  info(`  Compose command: ${cyan(`${bin} ${subcommand}`)}\n`);

  // 8. Resolve assets (download if needed)
  const spin1 = spinner("Resolving assets...");
  const assetsDir = await resolveAssets(options.ref);
  spin1.stop(green("Assets resolved"));

  // 9. Verify compose file exists in repository
  const assetComposeFile = join(process.cwd(), "assets", "state", "docker-compose.yml");
  const composeFileExists = await Bun.file(assetComposeFile).exists();
  if (!composeFileExists) {
    error(`Compose file not found at ${assetComposeFile}`);
    process.exit(1);
  }

  // 10. Resolve XDG paths, print them
  const xdg = resolveXDGPaths();
  log(bold("\nXDG paths:"));
  info(`  Data: ${dim(xdg.data)}`);
  info(`  Config: ${dim(xdg.config)}`);
  info(`  State: ${dim(xdg.state)}\n`);

  // 11. Check if .env exists in CWD, generate if not
  const envPath = join(process.cwd(), ".env");
  const envExists = await Bun.file(envPath).exists();

  let generatedAdminToken = "";
  if (!envExists) {
    const spin2 = spinner("Generating .env file...");
    generatedAdminToken = generateToken();
    const overrides: Record<string, string> = {
      ADMIN_TOKEN: generatedAdminToken,
      POSTGRES_PASSWORD: generateToken(),
      CHANNEL_CHAT_SECRET: generateToken(),
      CHANNEL_DISCORD_SECRET: generateToken(),
      CHANNEL_VOICE_SECRET: generateToken(),
      CHANNEL_TELEGRAM_SECRET: generateToken(),
    };
    const envSeed = Object.entries(overrides).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
    await writeFile(envPath, envSeed, "utf8");
    spin2.stop(green(".env file created"));

    // Display admin token prominently
    log("");
    log(bold(green("  YOUR ADMIN PASSWORD (save this!)")));
    log("");
    log(`  ${yellow(generatedAdminToken)}`);
    log("");
    info("  You will need this password to log in to the admin dashboard.");
    info(`  It is also saved in: ${dim(envPath)}`);
    log("");
  } else {
    info("Using existing .env file");
  }

  // 12. Upsert runtime config vars into .env
  const socketPath = resolveSocketPath(platform, os);
  await upsertEnvVar(envPath, "OPENPALM_DATA_HOME", xdg.data);
  await upsertEnvVar(envPath, "OPENPALM_CONFIG_HOME", xdg.config);
  await upsertEnvVar(envPath, "OPENPALM_STATE_HOME", xdg.state);
  await upsertEnvVar(envPath, "OPENPALM_CONTAINER_PLATFORM", platform);
  await upsertEnvVar(envPath, "OPENPALM_COMPOSE_BIN", bin);
  await upsertEnvVar(envPath, "OPENPALM_COMPOSE_SUBCOMMAND", subcommand);
  await upsertEnvVar(envPath, "OPENPALM_CONTAINER_SOCKET_PATH", socketPath);
  await upsertEnvVar(envPath, "OPENPALM_CONTAINER_SOCKET_IN_CONTAINER", "/var/run/docker.sock");
  await upsertEnvVar(envPath, "OPENPALM_CONTAINER_SOCKET_URI", "unix:///var/run/docker.sock");
  await upsertEnvVar(envPath, "OPENPALM_IMAGE_TAG", `latest-${arch}`);
  await upsertEnvVar(envPath, "OPENPALM_ENABLED_CHANNELS", "");

  // 13. Create XDG directory tree
  const spin3 = spinner("Creating directory structure...");
  await createDirectoryTree(xdg);
  spin3.stop(green("Directory structure created"));

  // 14. Copy compose file and .env to state home
  const stateComposeFile = join(xdg.state, "docker-compose.yml");
  const stateEnvFile = join(xdg.state, ".env");
  await copyFile(assetComposeFile, stateComposeFile);
  await copyFile(envPath, stateEnvFile);

  // 15. Seed config files
  const spin4 = spinner("Seeding configuration files...");
  await seedConfigFiles(assetsDir, xdg.config);
  spin4.stop(green("Configuration files seeded"));

  // 16. Reset setup wizard state so every install/reinstall starts from first boot
  await rm(join(xdg.data, "admin", "setup-state.json"), { force: true });

  // 17. Write uninstall script to state home
  const uninstallDst = join(xdg.state, "uninstall.sh");
  await writeFile(uninstallDst, "#!/usr/bin/env bash\nopenpalm uninstall\n", "utf8");
  try {
    await chmod(uninstallDst, 0o755);
  } catch {
    // chmod may fail on Windows — non-critical
  }

  // 18. Write minimal setup-only Caddyfile (admin routes only)
  const minimalCaddyfile = [
    "{",
    "\tadmin off",
    "}",
    "",
    ":80 {",
    "\thandle /admin* {",
    "\t\troute {",
    "\t\t\thandle /admin/api* {",
    "\t\t\t\turi replace /admin/api /admin",
    "\t\t\t\treverse_proxy admin:8100",
    "\t\t\t}",
    "\t\t\turi strip_prefix /admin",
    "\t\t\treverse_proxy admin:8100",
    "\t\t}",
    "\t}",
    "",
    "\thandle {",
    '\t\trespond "OpenPalm is starting... Please visit /admin/ to complete setup." 503',
    "\t}",
    "}",
    "",
  ].join("\n");
  const caddyfilePath = join(xdg.state, "rendered", "caddy", "Caddyfile");
  await writeFile(caddyfilePath, minimalCaddyfile, "utf8");

  // ============================================================================
  // Phase 2: Early UI access
  // ============================================================================

  log(bold("\nDownloading OpenPalm services (this may take a few minutes on first install)...\n"));

  const composeConfig: ComposeConfig = {
    bin,
    subcommand,
    composeFile: stateComposeFile,
    envFile: stateEnvFile,
  };

  const coreServices = ["caddy", "admin"];

  const spin6 = spinner("Pulling core service images...");
  await composePull(composeConfig, coreServices);
  spin6.stop(green("Core images pulled"));

  const spin7 = spinner("Starting core services...");
  await composeUp(composeConfig, coreServices, { detach: true });
  spin7.stop(green("Core services started"));

  // Wait for admin health check
  const adminUrl = "http://localhost/admin";
  const healthUrl = `${adminUrl}/api/setup/status`;
  const spin8 = spinner("Waiting for admin interface...");

  let healthy = false;
  for (let i = 0; i < 90; i++) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Service not ready yet
    }
    await Bun.sleep(2000);
  }

  if (!healthy) {
    spin8.stop(yellow("Admin interface did not become healthy in time"));
  } else {
    spin8.stop(green("Admin interface ready"));
  }

  // Open browser
  if (!options.noOpen && healthy) {
    try {
      if (os === "macos") {
        Bun.spawn(["open", adminUrl]);
      } else if (os === "linux") {
        Bun.spawn(["xdg-open", adminUrl]);
      } else {
        // Windows — use cmd /c start
        Bun.spawn(["cmd", "/c", "start", adminUrl]);
      }
    } catch {
      // Ignore — we print the URL below
    }
  }

  // ============================================================================
  // Final output
  // ============================================================================

  if (healthy) {
    log("");
    log(bold(green("  OpenPalm setup wizard is ready!")));
    log("");
    info(`  Setup wizard: ${cyan(adminUrl)}`);
    log("");
    if (generatedAdminToken) {
      info(`  Admin password: ${yellow(generatedAdminToken)}`);
      log("");
    }
    log(bold("  What happens next:"));
    info("    1. The setup wizard opens in your browser");
    info("    2. Enter your AI provider API key (e.g. from console.anthropic.com)");
    info("    3. The wizard will download and start remaining services automatically");
    info("    4. Pick which channels to enable (chat, Discord, etc.)");
    info("    5. Done! Start chatting with your assistant");
    log("");
    if (!options.noOpen) {
      info("  Opening setup wizard in your browser...");
    } else {
      info(`  Open this URL in your browser to continue: ${adminUrl}`);
    }
  } else {
    log("");
    log(bold(yellow("  Setup did not come online within 90 seconds")));
    log("");
    info("  This usually means containers are still starting. Try these steps:");
    log("");
    info(`  1. Wait a minute, then open: ${adminUrl}`);
    log("");
    info("  2. Check if containers are running:");
    info("     openpalm status");
    log("");
    info("  3. Check logs for errors:");
    info("     openpalm logs");
    log("");
    info("  4. Common fixes:");
    info("     - Make sure port 80 is not used by another service");
    info("     - Restart Docker/Podman and try again");
    info("     - Check that you have internet access (images need to download)");
  }

  log("");
  log(bold("  Useful commands:"));
  info("    View logs:  openpalm logs");
  info("    Stop:       openpalm stop");
  info("    Uninstall:  openpalm uninstall");
  log("");

  await cleanupTempAssets();
}
