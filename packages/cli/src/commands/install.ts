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
import { detectAllProviders, getSmallModelCandidates, writeProviderSeedFile } from "@openpalm/lib/detect-providers.ts";
import { log, info, warn, error, bold, green, cyan, yellow, dim, spinner, select } from "@openpalm/lib/ui.ts";

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
  if (os === "windows-bash") {
    error("Windows detected. Please use PowerShell instead:");
    info('  pwsh -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/itlackey/openpalm/main/install.ps1 -OutFile $env:TEMP/openpalm-install.ps1; & $env:TEMP/openpalm-install.ps1"');
    process.exit(1);
  }

  // 2. Detect arch
  const arch = detectArch();

  // 3. Detect or use overridden container runtime
  const platform = options.runtime ?? await detectRuntime(os);
  if (!platform) {
    error("No container runtime found. Please install Docker, Podman, or OrbStack.");
    process.exit(1);
  }

  // 4. Resolve compose bin/subcommand, validate runtime works
  const { bin, subcommand } = resolveComposeBin(platform);
  const isValid = await validateRuntime(bin, subcommand);
  if (!isValid) {
    error(`Container runtime validation failed for ${bin} ${subcommand}`);
    process.exit(1);
  }

  // 5. Print detected info
  log(bold("Detected environment:"));
  info(`  OS: ${cyan(os)}`);
  info(`  Architecture: ${cyan(arch)}`);
  info(`  Container runtime: ${cyan(platform)}`);
  info(`  Compose command: ${cyan(`${bin} ${subcommand}`)}\n`);

  // 6. Resolve assets (download if needed)
  const spin1 = spinner("Resolving assets...");
  const assetsDir = await resolveAssets(options.ref);
  spin1.stop(green("Assets resolved"));

  // 7. Verify compose file exists in repository
  const assetComposeFile = join(process.cwd(), "assets", "state", "docker-compose.yml");
  const composeFileExists = await Bun.file(assetComposeFile).exists();
  if (!composeFileExists) {
    error(`Compose file not found at ${assetComposeFile}`);
    process.exit(1);
  }

  // 8. Resolve XDG paths, print them
  const xdg = resolveXDGPaths();
  log(bold("\nXDG paths:"));
  info(`  Data: ${dim(xdg.data)}`);
  info(`  Config: ${dim(xdg.config)}`);
  info(`  State: ${dim(xdg.state)}\n`);

  // 9. Check if .env exists in CWD, generate if not
  const envPath = join(process.cwd(), ".env");
  const envExists = await Bun.file(envPath).exists();

  if (!envExists) {
    const spin2 = spinner("Generating .env file...");
    const overrides: Record<string, string> = {
      ADMIN_TOKEN: generateToken(),
      POSTGRES_PASSWORD: generateToken(),
      CHANNEL_CHAT_SECRET: generateToken(),
      CHANNEL_DISCORD_SECRET: generateToken(),
      CHANNEL_VOICE_SECRET: generateToken(),
      CHANNEL_TELEGRAM_SECRET: generateToken(),
    };
    const envSeed = Object.entries(overrides).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
    await writeFile(envPath, envSeed, "utf8");
    spin2.stop(green(".env file created"));
    log("");
    info("  Your admin token is in .env (ADMIN_TOKEN). You will need it during setup.");
    log("");
  } else {
    info("Using existing .env file");
  }

  // 10. Upsert runtime config vars into .env
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

  // 11. Create XDG directory tree
  const spin3 = spinner("Creating directory structure...");
  await createDirectoryTree(xdg);
  spin3.stop(green("Directory structure created"));

  // 12. Copy compose file and .env to state home
  const stateComposeFile = join(xdg.state, "docker-compose.yml");
  const stateEnvFile = join(xdg.state, ".env");
  await copyFile(assetComposeFile, stateComposeFile);
  await copyFile(envPath, stateEnvFile);

  // 13. Seed config files
  const spin4 = spinner("Seeding configuration files...");
  await seedConfigFiles(assetsDir, xdg.config);
  spin4.stop(green("Configuration files seeded"));

  // 14. Reset setup wizard state so every install/reinstall starts from first boot
  await rm(join(xdg.data, "admin", "setup-state.json"), { force: true });

  // 15. Write uninstall script to state home
  const uninstallDst = join(xdg.state, "uninstall.sh");
  await writeFile(uninstallDst, "#!/usr/bin/env bash\nopenpalm uninstall\n", "utf8");
  try {
    await chmod(uninstallDst, 0o755);
  } catch {
    // may not exist if seedFile skipped
  }

  // 16. Detect AI providers, write seed file
  const spin5 = spinner("Detecting AI providers...");
  const { providers, existingConfigPath } = await detectAllProviders();
  const providerSeedPath = join(xdg.data, "admin", "detected-providers.json");
  await writeProviderSeedFile(providers, providerSeedPath);
  spin5.stop(green(`Detected ${providers.length} AI provider(s)`));

  // Print detected providers
  for (const p of providers) {
    if (p.type === "local") {
      info(`  ${green("+")} ${p.name} (running locally — ${p.models.length} models available)`);
    } else if (p.apiKeyPresent) {
      info(`  ${green("+")} ${p.name} (API key found)`);
    } else {
      info(`  ${dim("-")} ${p.name} (no API key)`);
    }
  }

  // 16. If existingConfigPath found, print info
  if (existingConfigPath) {
    log("");
    info(`Found existing AI configuration at: ${dim(existingConfigPath)}`);
    info("You can review this file to configure your AI providers.");
  }

  // 17. If small model candidates exist, let user pick one
  const smallModels = getSmallModelCandidates(providers);
  if (smallModels.length > 0) {
    log("");
    log(bold("Small model selection:"));
    info("OpenPalm uses a small model for certain fast operations.");
    log("");

    const modelOptions = smallModels.map((m) => `${m.name} (${m.provider})`);
    const selectedIndex = await select("Choose a small model", modelOptions);
    const selectedModel = smallModels[selectedIndex];

    await upsertEnvVar(envPath, "OPENPALM_SMALL_MODEL", selectedModel.id);
    await upsertEnvVar(stateEnvFile, "OPENPALM_SMALL_MODEL", selectedModel.id);

    info(green(`Selected: ${selectedModel.name}\n`));
  }

  // ============================================================================
  // Phase 2: Early UI access
  // ============================================================================

  log(bold("\nStarting core services...\n"));

  // 1. Build ComposeConfig
  const composeConfig: ComposeConfig = {
    bin,
    subcommand,
    composeFile: stateComposeFile,
    envFile: stateEnvFile,
  };

  // 2. Pull + start minimal services
  const coreServices = ["caddy", "postgres", "admin"];

  const spin6 = spinner("Pulling core service images...");
  await composePull(composeConfig, coreServices);
  spin6.stop(green("Core images pulled"));

  const spin7 = spinner("Starting core services...");
  await composeUp(composeConfig, coreServices, { detach: true });
  spin7.stop(green("Core services started"));

  // 3. Wait for admin health check
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
    warn("Continuing with installation, but the admin interface may not be ready yet.");
  } else {
    spin8.stop(green("Admin interface ready"));
  }

  // 4. Open browser
  if (!options.noOpen && healthy) {
    try {
      if (os === "macos") {
        Bun.spawn(["open", adminUrl]);
      } else {
        Bun.spawn(["xdg-open", adminUrl]);
      }
      info(`Opened setup UI in your default browser: ${adminUrl}`);
    } catch {
      warn(`Could not open browser automatically. Visit: ${adminUrl}`);
    }
  } else if (!healthy) {
    info(`Complete setup at: ${adminUrl}`);
  } else {
    info(`Auto-open skipped (--no-open). Complete setup at: ${adminUrl}`);
  }

  // ============================================================================
  // Phase 3: Background pull
  // ============================================================================

  log(bold("\nPulling remaining images...\n"));

  const spin9 = spinner("Pulling remaining service images...");
  await composePull(composeConfig);
  spin9.stop(green("All images pulled"));

  // ============================================================================
  // Phase 4: Full stack
  // ============================================================================

  log(bold("\nStarting full stack...\n"));

  const spin10 = spinner("Starting all services...");
  await composeUp(composeConfig, undefined, { detach: true, pull: "always" });
  spin10.stop(green("All services started"));

  // Print final status
  log(bold("\nInstallation complete!\n"));

  log(bold("Service URLs:"));
  info(`  Admin:       ${cyan(adminUrl)}`);
  info(`  OpenMemory:  ${cyan(`${adminUrl}/openmemory`)}`);
  log("");

  log(bold("Container runtime:"));
  info(`  Platform:    ${cyan(platform)}`);
  info(`  Compose:     ${cyan(`${bin} ${subcommand}`)}`);
  info(`  Compose file: ${dim(stateComposeFile)}`);
  info(`  Socket:      ${dim(socketPath)}`);
  log("");

  log(bold("Host directories:"));
  info(`  Data:   ${dim(xdg.data)}`);
  info(`  Config: ${dim(xdg.config)}`);
  info(`  State:  ${dim(xdg.state)}`);
  log("");

  info("If you want channel adapters: openpalm start --profile channels");
  log("");

  // Clean up any temp directories created during asset downloads
  await cleanupTempAssets();
}
