import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import type { InstallOptions } from "../types.ts";
import type { ComposeConfig } from "@openpalm/lib/types.ts";
import { detectOS, detectArch, detectRuntime, resolveSocketPath, COMPOSE_BIN, validateRuntime } from "@openpalm/lib/runtime.ts";
import { resolveXDGPaths, resolveWorkHome, createDirectoryTree } from "@openpalm/lib/paths.ts";
import { readEnvFile, upsertEnvVar, upsertEnvVars } from "@openpalm/lib/env.ts";
import { generateToken } from "@openpalm/lib/tokens.ts";
import { composePull, composeUp } from "@openpalm/lib/compose.ts";
import { seedConfigFiles } from "@openpalm/lib/assets.ts";
import { BUILTIN_CHANNELS } from "@openpalm/lib/assets/channels/index.ts";
import { runPreflightChecksDetailed, noRuntimeGuidance, noComposeGuidance } from "@openpalm/lib/preflight.ts";
import { readInstallMetadata, writeInstallMetadata, createInstallMetadata } from "@openpalm/lib/install-metadata.ts";
import { log, info, warn, error, bold, green, cyan, yellow, dim, spinner, confirm } from "@openpalm/lib/ui.ts";

function reportIssueUrl(context: { os: string; arch: string; error: string }): string {
  const title = encodeURIComponent(`Install failure: ${context.error.slice(0, 80)}`);
  const body = encodeURIComponent(
    `## Environment\n` +
    `- OS: ${context.os}\n` +
    `- Arch: ${context.arch}\n` +
    `- Runtime: docker\n\n` +
    `## Error\n\`\`\`\n${context.error}\n\`\`\`\n\n` +
    `## Steps to Reproduce\n1. Ran \`openpalm install\`\n`
  );
  return `https://github.com/itlackey/openpalm/issues/new?title=${title}&body=${body}`;
}

/** Path to the embedded full-stack docker-compose.yml */
const EMBEDDED_COMPOSE_PATH = join(
  import.meta.dir, "..", "..", "..", "lib", "src", "embedded", "state", "docker-compose.yml"
);

/** Check if OpenPalm is already installed. Returns true if user wants to abort. */
async function checkExistingInstall(
  stateComposeFile: string,
  stateEnvFile: string,
  existingMetadata: ReturnType<typeof readInstallMetadata>,
): Promise<boolean> {
  let alreadyInstalled = false;
  if (existingMetadata) {
    alreadyInstalled = true;
  } else {
    try {
      const existingCompose = await Bun.file(stateComposeFile).text();
      if (existingCompose.includes("gateway:") && existingCompose.includes("assistant:")) {
        alreadyInstalled = true;
      }
    } catch {
      // Compose file doesn't exist — fresh install
    }
  }
  if (!alreadyInstalled) return false;

  warn("OpenPalm appears to already be installed.");
  if (existingMetadata) {
    info(`  Installed: ${dim(existingMetadata.installedAt)}`);
    info(`  Port: ${dim(String(existingMetadata.port))}`);
  }
  info("");
  info("  To update to the latest version, run:");
  info(`    ${cyan("openpalm update")}`);
  info("");
  info("  To reinstall from scratch, run:");
  info(`    ${cyan("openpalm install --force")}`);
  log("");
  return !(await confirm("Continue anyway and overwrite the existing installation?"));
}

/** Generate initial secrets .env or fix insecure defaults. Returns generated admin token (if any). */
async function ensureSecrets(stateEnvFile: string): Promise<string> {
  let generatedAdminToken = "";
  if (await Bun.file(stateEnvFile).exists()) {
    info("Using existing state .env file");
  } else {
    const spin = spinner("Generating .env file...");
    generatedAdminToken = generateToken();
    const channelSecrets: Record<string, string> = {};
    for (const def of Object.values(BUILTIN_CHANNELS)) {
      channelSecrets[def.sharedSecretEnv] = generateToken();
    }
    const overrides: Record<string, string> = {
      ADMIN_TOKEN: generatedAdminToken,
      POSTGRES_PASSWORD: generateToken(),
      ...channelSecrets,
    };
    const envSeed = Object.entries(overrides).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
    await writeFile(stateEnvFile, envSeed, { encoding: "utf8", mode: 0o600 });
    spin.stop(green(".env file created"));
  }

  // Regenerate insecure default admin token if needed
  if (!generatedAdminToken) {
    const existingEnv = await readEnvFile(stateEnvFile);
    if (!existingEnv.ADMIN_TOKEN || existingEnv.ADMIN_TOKEN === "change-me-admin-token") {
      generatedAdminToken = generateToken();
      await upsertEnvVar(stateEnvFile, "ADMIN_TOKEN", generatedAdminToken);
      warn("Insecure default admin token detected — regenerated with a secure token.");
    }
  }

  if (generatedAdminToken) {
    log("");
    info(`  Admin token saved in: ${dim(stateEnvFile)}`);
    log("");
  }
  return generatedAdminToken;
}

/** Build Caddy JSON config for the default install routes. */
function buildCaddyConfig(ingressPort: number): string {
  return JSON.stringify({
    admin: { disabled: true },
    apps: {
      http: {
        servers: {
          main: {
            listen: [`:${ingressPort}`],
            routes: [
              {
                match: [{ path: ["/api*"], remote_ip: { ranges: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "::1/128", "fd00::/8"] } }],
                handle: [{ handler: "subroute", routes: [{ handle: [{ handler: "rewrite", strip_path_prefix: "/api" }, { handler: "reverse_proxy", upstreams: [{ dial: "admin:8100" }] }] }] }],
                terminal: true,
              },
              {
                match: [{ path: ["/channels/*"] }],
                handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "channel-chat:8181" }] }],
                terminal: true,
              },
              {
                handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "assistant:4096" }] }],
              },
            ],
          },
        },
      },
    },
  }, null, 2) + "\n";
}

/** Poll health endpoints with exponential backoff. */
async function waitForHealthy(adminDirectUrl: string): Promise<{ admin: boolean; gateway: boolean }> {
  let admin = false;
  let gateway = false;
  let delay = 1000;
  const maxDelay = 5000;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (!admin) {
      try {
        const resp = await fetch(`${adminDirectUrl}/health`, { signal: AbortSignal.timeout(3000) });
        if (resp.ok) admin = true;
      } catch { /* not ready */ }
    }
    if (!gateway) {
      try {
        const resp = await fetch("http://localhost:8080/health", { signal: AbortSignal.timeout(3000) });
        if (resp.ok) gateway = true;
      } catch { /* not ready */ }
    }
    if (admin && gateway) break;
    await Bun.sleep(delay);
    delay = Math.min(delay * 1.5, maxDelay);
  }
  return { admin, gateway };
}

/** Detect OS, arch, runtime, compose — exits on failure. */
async function detectEnvironment(ingressPort: number) {
  const os = detectOS();
  if (os === "unknown") {
    error("Unable to detect operating system. Installation aborted.");
    process.exit(1);
  }
  const arch = detectArch();
  const platform = await detectRuntime();
  if (!platform) {
    error(noRuntimeGuidance(os));
    info("");
    info("  If this keeps happening, report the issue:");
    info(`    ${cyan(reportIssueUrl({ os, arch, error: "Docker not found" }))}`);
    process.exit(1);
  }
  const { bin, subcommand } = COMPOSE_BIN;

  // Pre-flight checks
  const preflightResult = await runPreflightChecksDetailed(bin, ingressPort);
  for (const issue of preflightResult.issues) {
    warn(issue.message);
    if (issue.detail) issue.detail.split("\n").forEach((l) => info(`  ${l}`));
    log("");
  }
  const daemonIssue = preflightResult.issues.find((i) => i.code === "daemon_unavailable" || i.code === "daemon_check_failed");
  if (daemonIssue) {
    error("Docker daemon is unavailable. Please start Docker and rerun install.");
    info(`    ${cyan(reportIssueUrl({ os, arch, error: daemonIssue.message }))}`);
    process.exit(1);
  }
  const portIssue = preflightResult.issues.find((i) => i.code === "port_conflict");
  if (portIssue) {
    error("Port 80 is required but already in use. Use --port to specify an alternative.");
    process.exit(1);
  }
  if (!(await validateRuntime(bin, subcommand))) {
    error(noComposeGuidance());
    process.exit(1);
  }
  return { os, arch, platform, bin, subcommand };
}

/** Pull images and start the compose stack — exits on pull failure. */
async function pullAndStart(config: ComposeConfig, ctx: { os: string; arch: string }) {
  const { os, arch } = ctx;
  const spin1 = spinner("Pulling service images...");
  try {
    await composePull(config);
    spin1.stop(green("Images pulled"));
  } catch (pullErr) {
    spin1.stop(yellow("Failed to pull images"));
    warn("Image pull failed. This can happen due to network issues or rate limits.");
    info(`  To retry: ${cyan("openpalm install --force")}`);
    info(`  Report: ${cyan(reportIssueUrl({ os, arch, error: String(pullErr) }))}`);
    process.exit(1);
  }
  const spin2 = spinner("Starting services...");
  await composeUp(config, undefined, { detach: true });
  spin2.stop(green("Services started"));
}

/** Print healthy/unhealthy final status + useful commands. */
function printInstallSummary(
  healthy: boolean,
  health: { admin: boolean; gateway: boolean },
  adminUrl: string,
  adminDirectUrl: string,
  ctx: { os: string; arch: string },
) {
  const { os, arch } = ctx;
  log("");
  if (healthy) {
    log(bold(green("  OpenPalm is running!")));
    log("");
    info(`  Admin API:  ${cyan(adminUrl + "/api")}`);
    info(`  Admin API (direct):  ${cyan(adminDirectUrl)}`);
    info(`  Gateway:    ${cyan("http://localhost:8080")}`);
  } else {
    log(bold(yellow("  Some services did not come online within 3 minutes")));
    log("");
    (health.admin ? info : warn)(`  Admin: ${health.admin ? "healthy" : "not responding"}`);
    (health.gateway ? info : warn)(`  Gateway: ${health.gateway ? "healthy" : "not responding"}`);
    log("");
    info("  Check status:  openpalm status");
    info("  Check logs:    openpalm logs");
    log("");
    info("  If this keeps happening, report the issue:");
    info(`    ${cyan(reportIssueUrl({ os, arch, error: "Health check timeout after 3 minutes" }))}`);
  }
  log("");
  log(bold("  Useful commands:"));
  info("    View logs:  openpalm logs");
  info("    Status:     openpalm status");
  info("    Stop:       openpalm stop");
  info("    Uninstall:  openpalm uninstall");
  log("");
}

export async function install(options: InstallOptions): Promise<void> {
  log(bold("\nOpenPalm Installation\n"));

  const ingressPort = options.port ?? 80;
  const { os, arch, platform, bin, subcommand } = await detectEnvironment(ingressPort);

  log(bold("Detected environment:"));
  info(`  OS: ${cyan(os)}`);
  info(`  Architecture: ${cyan(arch)}`);
  info(`  Compose command: ${cyan(`${bin} ${subcommand}`)}\n`);

  const xdg = resolveXDGPaths();
  log(bold("XDG paths:"));
  info(`  Data: ${dim(xdg.data)}`);
  info(`  Config: ${dim(xdg.config)}`);
  info(`  State: ${dim(xdg.state)}\n`);

  const stateComposeFile = join(xdg.state, "docker-compose.yml");
  const stateEnvFile = join(xdg.state, ".env");
  const existingMetadata = readInstallMetadata(xdg.state);
  if (!options.force) {
    if (await checkExistingInstall(stateComposeFile, stateEnvFile, existingMetadata)) {
      log("Aborted.");
      return;
    }
  }

  const spin3 = spinner("Creating directory structure...");
  await createDirectoryTree(xdg);
  spin3.stop(green("Directory structure created"));

  await ensureSecrets(stateEnvFile);

  const socketPath = resolveSocketPath(os);
  const normPath = (p: string) => p.replace(/\\/g, "/");
  await upsertEnvVars(stateEnvFile, [
    ["OPENPALM_DATA_HOME", normPath(xdg.data)],
    ["OPENPALM_CONFIG_HOME", normPath(xdg.config)],
    ["OPENPALM_STATE_HOME", normPath(xdg.state)],
    ["OPENPALM_CONTAINER_PLATFORM", platform],
    ["OPENPALM_COMPOSE_BIN", bin],
    ["OPENPALM_COMPOSE_SUBCOMMAND", subcommand],
    ["OPENPALM_CONTAINER_SOCKET_PATH", socketPath],
    ["OPENPALM_IMAGE_NAMESPACE", "openpalm"],
    ["OPENPALM_IMAGE_TAG", `latest-${arch}`],
    ["OPENPALM_WORK_HOME", normPath(resolveWorkHome())],
    ["OPENPALM_UID", String(process.getuid?.() ?? 1000)],
    ["OPENPALM_GID", String(process.getgid?.() ?? 1000)],
    ["OPENPALM_INGRESS_PORT", String(ingressPort)],
  ]);

  await Bun.write(join(process.cwd(), ".env"), Bun.file(stateEnvFile));

  const spin4 = spinner("Seeding configuration files...");
  await seedConfigFiles(xdg.config);
  spin4.stop(green("Configuration files seeded"));

  const systemEnvPath = join(xdg.state, "system.env");
  if (!(await Bun.file(systemEnvPath).exists())) {
    await writeFile(systemEnvPath, "# Generated system env — populated on first stack apply\n", "utf8");
  }

  const spin5 = spinner("Writing compose configuration...");
  const embeddedCompose = readFileSync(EMBEDDED_COMPOSE_PATH, "utf8");
  await writeFile(stateComposeFile, embeddedCompose, "utf8");
  spin5.stop(green("Compose configuration written"));

  await writeFile(join(xdg.state, "caddy.json"), buildCaddyConfig(ingressPort), "utf8");

  log(bold("\nDownloading OpenPalm services (this may take a few minutes on first install)...\n"));
  const composeConfig: ComposeConfig = { bin, subcommand, composeFile: stateComposeFile, envFile: stateEnvFile };
  await pullAndStart(composeConfig, { os, arch });

  const adminUrl = ingressPort === 80 ? "http://localhost" : `http://localhost:${ingressPort}`;
  const adminDirectUrl = "http://localhost:8100";
  const spin8 = spinner("Waiting for services to become healthy...");
  const health = await waitForHealthy(adminDirectUrl);
  const healthy = health.admin && health.gateway;
  spin8.stop(healthy ? green("All services healthy") : yellow("Some services did not become healthy in time"));

  // Write install metadata
  const installMode = existingMetadata ? "reinstall" : "fresh";
  const metadata = createInstallMetadata({
    mode: installMode,
    runtime: platform,
    port: ingressPort,
  });
  writeInstallMetadata(xdg.state, metadata);

  printInstallSummary(healthy, health, adminUrl, adminDirectUrl, { os, arch });
}
