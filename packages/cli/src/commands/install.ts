import { join } from "node:path";
import { chmod, writeFile, rm, stat } from "node:fs/promises";
import type { InstallOptions } from "../types.ts";
import type { ComposeConfig } from "@openpalm/lib/types.ts";
import { detectOS, detectArch, detectRuntime, resolveSocketPath, resolveSocketUri, resolveInContainerSocketPath, resolveComposeBin, validateRuntime } from "@openpalm/lib/runtime.ts";
import { resolveXDGPaths, resolveWorkHome, createDirectoryTree } from "@openpalm/lib/paths.ts";
import { readEnvFile, upsertEnvVar, upsertEnvVars } from "@openpalm/lib/env.ts";
import { generateToken } from "@openpalm/lib/tokens.ts";
import { composePull, composeUp } from "@openpalm/lib/compose.ts";
import { seedConfigFiles } from "@openpalm/lib/assets.ts";
import { runPreflightChecks, noRuntimeGuidance, noComposeGuidance } from "@openpalm/lib/preflight.ts";
import { log, info, warn, error, bold, green, cyan, yellow, dim, spinner, confirm } from "@openpalm/lib/ui.ts";

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

  // Daemon not running is fatal — we can't proceed.
  // Check for daemon-related warnings by looking for known preflight patterns
  // rather than relying on a single exact string match.
  const daemonWarning = preflightWarnings.find((w) =>
    w.message.includes("daemon is not running") ||
    w.message.includes("daemon") ||
    w.message.includes("Could not verify")
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
  info(`  Container runtime: ${cyan(platform)}${platform === "podman" ? yellow(" (experimental)") : ""}`);
  info(`  Compose command: ${cyan(`${bin} ${subcommand}`)}\n`);

  if (platform === "podman") {
    warn("Podman support is experimental. Some features may not work as expected.");
    info("  For the most reliable experience, we recommend Docker Desktop or Docker Engine.");
    log("");
  }

  // 8. Resolve XDG paths, print them
  const xdg = resolveXDGPaths();
  log(bold("\nXDG paths:"));
  info(`  Data: ${dim(xdg.data)}`);
  info(`  Config: ${dim(xdg.config)}`);
  info(`  State: ${dim(xdg.state)}\n`);

  // 9. Idempotency guard — check if OpenPalm is already installed
  const stateComposeFile = join(xdg.state, "docker-compose.yml");
  const stateEnvFile = join(xdg.state, ".env");
  if (!options.force) {
    try {
      const existingCompose = await Bun.file(stateComposeFile).text();
      // If compose file exists and contains services beyond caddy+admin, it's a full install
      if (existingCompose.includes("gateway:") && existingCompose.includes("assistant:")) {
        warn("OpenPalm appears to already be installed.");
        info("  The existing compose file contains a full stack configuration.");
        info("");
        info("  To update to the latest version, run:");
        info(`    ${cyan("openpalm update")}`);
        info("");
        info("  To reinstall from scratch, run:");
        info(`    ${cyan("openpalm install --force")}`);
        log("");
        const shouldContinue = await confirm("Continue anyway and overwrite the existing installation?");
        if (!shouldContinue) {
          log("Aborted.");
          return;
        }
      }
    } catch {
      // Compose file doesn't exist — fresh install, proceed
    }
  }

  // 10. Create XDG directory tree first (needed before writing state .env)
  const spin3 = spinner("Creating directory structure...");
  await createDirectoryTree(xdg);
  spin3.stop(green("Directory structure created"));

  // 11. Generate secrets and write canonical .env to state home first
  const cwdEnvPath = join(process.cwd(), ".env");
  const cwdEnvExists = await Bun.file(cwdEnvPath).exists();
  const stateEnvExists = await Bun.file(stateEnvFile).exists();

  // Determine which .env to use as starting point
  let generatedAdminToken = "";
  if (stateEnvExists) {
    info("Using existing state .env file");
  } else if (cwdEnvExists) {
    info("Using existing .env file from current directory");
    await Bun.write(stateEnvFile, Bun.file(cwdEnvPath));
  } else {
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
    await writeFile(stateEnvFile, envSeed, { encoding: "utf8", mode: 0o600 });
    spin2.stop(green(".env file created"));
  }

  // 12. Check for insecure default admin token and regenerate if needed
  if (!generatedAdminToken) {
    const existingEnv = await readEnvFile(stateEnvFile);
    if (!existingEnv.ADMIN_TOKEN || existingEnv.ADMIN_TOKEN === "change-me-admin-token") {
      generatedAdminToken = generateToken();
      await upsertEnvVar(stateEnvFile, "ADMIN_TOKEN", generatedAdminToken);
      warn("Insecure default admin token detected — regenerated with a secure token.");
    }
  }

  // Display admin token prominently if we generated one
  if (generatedAdminToken) {
    log("");
    log(bold(green("  YOUR ADMIN PASSWORD (save this!)")));
    log("");
    log(`  ${yellow(generatedAdminToken)}`);
    log("");
    info("  You will need this password to log in to the admin dashboard.");
    info(`  It is also saved in: ${dim(stateEnvFile)}`);
    log("");
  }

  // 13. Upsert runtime config vars into canonical state .env (single read-write cycle)
  const socketPath = resolveSocketPath(platform, os);
  const socketUri = resolveSocketUri(platform, os);
  const inContainerSocket = resolveInContainerSocketPath(platform);
  // Normalize backslashes to forward slashes for Docker Compose compatibility on Windows
  const normPath = (p: string) => p.replace(/\\/g, "/");
  await upsertEnvVars(stateEnvFile, [
    ["OPENPALM_DATA_HOME", normPath(xdg.data)],
    ["OPENPALM_CONFIG_HOME", normPath(xdg.config)],
    ["OPENPALM_STATE_HOME", normPath(xdg.state)],
    ["OPENPALM_CONTAINER_PLATFORM", platform],
    ["OPENPALM_COMPOSE_BIN", bin],
    ["OPENPALM_COMPOSE_SUBCOMMAND", subcommand],
    ["OPENPALM_CONTAINER_SOCKET_PATH", socketPath],
    ["OPENPALM_CONTAINER_SOCKET_IN_CONTAINER", inContainerSocket],
    ["OPENPALM_CONTAINER_SOCKET_URI", socketUri],
    ["OPENPALM_IMAGE_NAMESPACE", "openpalm"],
    ["OPENPALM_IMAGE_TAG", `latest-${arch}`],
    ["OPENPALM_WORK_HOME", normPath(resolveWorkHome())],
    ["OPENPALM_ENABLED_CHANNELS", ""],
  ]);

  // 14. Copy canonical .env to CWD for user convenience
  await Bun.write(cwdEnvPath, Bun.file(stateEnvFile));

  // 15. Seed config files (embedded templates — no network needed)
  const spin4 = spinner("Seeding configuration files...");
  await seedConfigFiles(xdg.config);
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

  // 18. Write an empty system.env so the admin env_file reference resolves
  const systemEnvPath = join(xdg.state, "system.env");
  const systemEnvExists = await Bun.file(systemEnvPath).exists();
  if (!systemEnvExists) {
    await writeFile(systemEnvPath, "# Generated system env — populated on first stack apply\n", "utf8");
  }

  // 19. Write minimal setup-only Caddy JSON config (admin routes only)
  const minimalCaddyJson = JSON.stringify({
    admin: { disabled: true },
    apps: {
      http: {
        servers: {
          main: {
            listen: [":80"],
            routes: [
              {
                match: [{ path: ["/admin*"] }],
                handle: [{
                  handler: "subroute",
                  routes: [
                    {
                      match: [{ path: ["/admin/api*"] }],
                      handle: [
                        { handler: "rewrite", uri_substring: [{ find: "/admin/api", replace: "/admin" }] },
                        { handler: "reverse_proxy", upstreams: [{ dial: "admin:8100" }] },
                      ],
                      terminal: true,
                    },
                    {
                      handle: [
                        { handler: "rewrite", strip_path_prefix: "/admin" },
                        { handler: "reverse_proxy", upstreams: [{ dial: "admin:8100" }] },
                      ],
                    },
                  ],
                }],
                terminal: true,
              },
              {
                handle: [{
                  handler: "static_response",
                  body: "OpenPalm is starting... Please visit /admin/ to complete setup.",
                  status_code: "503",
                }],
              },
            ],
          },
        },
      },
    },
  }, null, 2) + "\n";
  const caddyJsonPath = join(xdg.state, "rendered", "caddy", "caddy.json");
  await writeFile(caddyJsonPath, minimalCaddyJson, "utf8");

  // ============================================================================
  // Phase 2: Early UI access
  // ============================================================================

  log(bold("\nDownloading OpenPalm services (this may take a few minutes on first install)...\n"));

  // Write a minimal compose file with just caddy + admin so we can pull/start
  // before the admin wizard generates the full stack compose file.
  const minimalCompose = `services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "\${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:80:80"
      - "\${OPENPALM_INGRESS_BIND_ADDRESS:-127.0.0.1}:443:443"
    volumes:
      - \${OPENPALM_STATE_HOME}/rendered/caddy/caddy.json:/etc/caddy/caddy.json:ro
      - \${OPENPALM_STATE_HOME}/caddy/data:/data/caddy
      - \${OPENPALM_STATE_HOME}/caddy/config:/config/caddy
    command: caddy run --config /etc/caddy/caddy.json
    networks: [assistant_net]

  admin:
    image: \${OPENPALM_IMAGE_NAMESPACE:-openpalm}/admin:\${OPENPALM_IMAGE_TAG:-latest}
    restart: unless-stopped
    env_file:
      - \${OPENPALM_STATE_HOME}/system.env
    environment:
      - PORT=8100
      - ADMIN_TOKEN=\${ADMIN_TOKEN:-change-me-admin-token}
      - GATEWAY_URL=http://gateway:8080
      - OPENCODE_CORE_URL=http://assistant:4096
      - OPENPALM_COMPOSE_BIN=\${OPENPALM_COMPOSE_BIN:-docker}
      - OPENPALM_COMPOSE_SUBCOMMAND=\${OPENPALM_COMPOSE_SUBCOMMAND:-compose}
      - OPENPALM_CONTAINER_SOCKET_URI=\${OPENPALM_CONTAINER_SOCKET_URI:-unix:///var/run/docker.sock}
      - COMPOSE_PROJECT_PATH=/state
      - OPENPALM_COMPOSE_FILE=docker-compose.yml
    volumes:
      - \${OPENPALM_DATA_HOME}:/data
      - \${OPENPALM_CONFIG_HOME}:/config
      - \${OPENPALM_STATE_HOME}:/state
      - \${OPENPALM_WORK_HOME:-\${HOME}/openpalm}:/work
      - \${OPENPALM_CONTAINER_SOCKET_PATH:-/var/run/docker.sock}:\${OPENPALM_CONTAINER_SOCKET_IN_CONTAINER:-/var/run/docker.sock}
    networks: [assistant_net]
    healthcheck:
      test: ["CMD", "curl", "-fs", "http://localhost:8100/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

networks:
  channel_net:
  assistant_net:
`;
  await writeFile(stateComposeFile, minimalCompose, "utf8");

  const composeConfig: ComposeConfig = {
    bin,
    subcommand,
    composeFile: stateComposeFile,
    envFile: stateEnvFile,
  };

  const coreServices = ["caddy", "admin"];

  // Pull with graceful error handling
  const spin6 = spinner("Pulling core service images...");
  try {
    await composePull(composeConfig, coreServices);
    spin6.stop(green("Core images pulled"));
  } catch (pullErr) {
    spin6.stop(yellow("Failed to pull core images"));
    warn("Image pull failed. This can happen due to network issues or rate limits.");
    info("");
    info("  To retry, run:");
    info(`    ${cyan("openpalm install")}`);
    info("");
    info("  Or manually pull and then start:");
    info(`    ${cyan(`${bin} ${subcommand} --env-file ${stateEnvFile} -f ${stateComposeFile} pull`)}`);
    info(`    ${cyan(`${bin} ${subcommand} --env-file ${stateEnvFile} -f ${stateComposeFile} up -d`)}`);
    log("");
    process.exit(1);
  }

  const spin7 = spinner("Starting core services...");
  await composeUp(composeConfig, coreServices, { detach: true });
  spin7.stop(green("Core services started"));

  // Wait for admin health check with exponential backoff
  const adminUrl = "http://localhost/admin";
  const healthUrl = `${adminUrl}/api/setup/status`;
  const spin8 = spinner("Waiting for admin interface...");

  let healthy = false;
  let delay = 1000; // Start at 1s
  const maxDelay = 5000; // Cap at 5s
  const deadline = Date.now() + 180_000; // 3 minutes total
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      // Service not ready yet
    }
    await Bun.sleep(delay);
    delay = Math.min(delay * 1.5, maxDelay);
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
    log(bold(yellow("  Setup did not come online within 3 minutes")));
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
}
