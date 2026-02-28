if (typeof globalThis.Bun === "undefined") {
  globalThis.Bun = {
    env: typeof process !== "undefined" ? process.env : {},
    spawn() {
      throw new Error("Bun.spawn not available in Node");
    },
    spawnSync() {
      throw new Error("Bun.spawnSync not available in Node");
    }
  };
}
const transientErrorMatchers = [
  { pattern: /Cannot connect to the Docker daemon|error during connect|dial unix/i, code: "daemon_unreachable", retryable: true },
  { pattern: /pull access denied|manifest unknown|failed to fetch/i, code: "image_pull_failed", retryable: true },
  { pattern: /permission denied|access denied/i, code: "permission_denied", retryable: false },
  { pattern: /yaml:|invalid compose|unsupported config/i, code: "invalid_compose", retryable: false }
];
function classifyError(stderr) {
  for (const matcher of transientErrorMatchers) {
    if (matcher.pattern.test(stderr)) return { code: matcher.code, retryable: matcher.retryable };
  }
  return { code: "unknown", retryable: false };
}
function buildComposeArgs(options, args) {
  const base = [];
  if (options.subcommand) base.push(options.subcommand);
  if (options.envFile) base.push("--env-file", options.envFile);
  base.push("-f", options.composeFile);
  return [...base, ...args];
}
async function runComposeOnce(args, options) {
  const composeArgs = buildComposeArgs(options, args);
  const stream = options.stream ?? false;
  const timeoutMs = options.timeoutMs ?? (stream ? 0 : 3e4);
  const controller = timeoutMs > 0 ? new AbortController() : void 0;
  const spawn = options.spawn ?? Bun.spawn;
  const spawnOptions = {
    stdout: stream ? "inherit" : "pipe",
    stderr: stream ? "inherit" : "pipe",
    stdin: "inherit",
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    signal: controller?.signal
  };
  let timeoutId;
  if (controller && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort("timeout"), timeoutMs);
  }
  let proc;
  try {
    proc = spawn([options.bin, ...composeArgs], spawnOptions);
    await proc.exited;
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = controller?.signal.aborted === true || message.includes("timeout");
    const classified2 = classifyError(message);
    const code = isTimeout ? "timeout" : classified2.code;
    return { ok: false, exitCode: 1, stdout: "", stderr: message, code };
  }
  if (timeoutId) clearTimeout(timeoutId);
  const exitCode = proc.exitCode ?? 1;
  const stdoutStream = proc.stdout;
  const stderrStream = proc.stderr;
  const stdout = stream || typeof stdoutStream === "number" || !stdoutStream ? "" : await new Response(stdoutStream).text();
  const stderr = stream || typeof stderrStream === "number" || !stderrStream ? "" : await new Response(stderrStream).text();
  if (exitCode === 0) return { ok: true, exitCode, stdout, stderr, code: "unknown" };
  const classified = classifyError(stderr);
  return { ok: false, exitCode, stdout, stderr, code: classified.code };
}
async function runCompose(args, options) {
  const retries = options.retries ?? 2;
  let attempt = 0;
  while (true) {
    const result = await runComposeOnce(args, options);
    if (result.ok) return result;
    if (result.code === "timeout") return result;
    const classified = classifyError(result.stderr);
    if (classified.code !== "unknown") result.code = classified.code;
    if (!classified.retryable || attempt >= retries) return result;
    attempt += 1;
  }
}
const CoreServices = [
  "assistant",
  "gateway",
  "openmemory",
  "admin",
  "caddy",
  "openmemory-ui",
  "postgres",
  "qdrant"
];
const UiManagedServiceExclusions = ["admin", "caddy"];
const SetupStartupServices = CoreServices.filter((service) => service !== "admin");
function envValue(name) {
  const bunEnv = globalThis.Bun?.env;
  return bunEnv?.[name] ?? process.env[name];
}
function composeProjectPath() {
  return envValue("COMPOSE_PROJECT_PATH") ?? "/state";
}
function composeBin() {
  return envValue("OPENPALM_COMPOSE_BIN") ?? "docker";
}
function composeSubcommand() {
  return envValue("OPENPALM_COMPOSE_SUBCOMMAND") ?? "compose";
}
function composeFilePath() {
  return envValue("OPENPALM_COMPOSE_FILE") ?? "docker-compose.yml";
}
function containerSocketUri() {
  return envValue("OPENPALM_CONTAINER_SOCKET_URI") ?? "unix:///var/run/docker.sock";
}
function extraServicesFromEnv() {
  return (envValue("OPENPALM_EXTRA_SERVICES") ?? "").split(",").map((value) => value.trim()).filter((value) => value.length > 0);
}
function createComposeRunner(envFile, spawn) {
  const resolvedEnvFile = envFile ?? `${composeProjectPath()}/.env`;
  const run = (args, composeFileOverride, stream) => execCompose(args, composeFileOverride, resolvedEnvFile, stream, spawn);
  return {
    action: (action, service) => runAction(run, action, service),
    exec: (service, args) => runExec(run, service, args),
    list: () => run(["ps", "--format", "json"]),
    ps: () => runPs(run),
    configServices: (composeFileOverride) => runConfigServices(run, composeFileOverride),
    configValidate: () => run(["config"]),
    configValidateForFile: (composeFile, envFileOverride) => execCompose(["config"], composeFile, envFileOverride ?? resolvedEnvFile, void 0, spawn),
    pull: (service) => runPull(run, service),
    logs: (service, tail) => runLogs(run, service, tail),
    stackDown: () => run(["down", "--remove-orphans"], void 0, true)
  };
}
function createMockRunner(overrides) {
  const ok = { ok: true, stdout: "", stderr: "" };
  return {
    action: async () => ok,
    exec: async () => ok,
    list: async () => ({ ...ok, stdout: "[]" }),
    ps: async () => ({ ok: true, services: [], stderr: "" }),
    configServices: async () => [],
    configValidate: async () => ok,
    configValidateForFile: async () => ok,
    pull: async () => ok,
    logs: async () => ok,
    stackDown: async () => ok,
    ...overrides
  };
}
async function execCompose(args, composeFileOverride, envFile, stream, spawn) {
  const composeFile = composeFileOverride ?? composeFilePath();
  const result = await runCompose(args, {
    bin: composeBin(),
    subcommand: composeSubcommand(),
    composeFile,
    envFile,
    cwd: composeProjectPath(),
    env: {
      DOCKER_HOST: containerSocketUri(),
      CONTAINER_HOST: containerSocketUri()
    },
    stream,
    spawn
  });
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    code: result.code
  };
}
async function ensureAllowedServices(run, services) {
  const result = await run(["config", "--services"]);
  const fromCompose = result.ok ? result.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0) : [];
  const allowed = /* @__PURE__ */ new Set([...CoreServices, ...extraServicesFromEnv(), ...fromCompose]);
  for (const service of services) {
    if (!allowed.has(service)) return service;
  }
  return null;
}
async function runPs(run) {
  const result = await run(["ps", "--format", "json"]);
  if (!result.ok) return { ok: false, services: [], stderr: result.stderr };
  const trimmed = result.stdout.trim();
  if (trimmed.length === 0) return { ok: true, services: [], stderr: "" };
  try {
    const raw = JSON.parse(trimmed);
    const services = raw.map((entry) => ({
      name: String(entry.Service ?? entry.Name ?? ""),
      status: String(entry.State ?? entry.Status ?? ""),
      health: entry.Health ? String(entry.Health) : null
    })).filter((entry) => entry.name.length > 0);
    return { ok: true, services, stderr: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, services: [], stderr: `compose_ps_parse_failed:${message}` };
  }
}
async function runPull(run, service) {
  if (service) {
    const invalid = await ensureAllowedServices(run, [service]);
    if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
    return run(["pull", service], void 0, true);
  }
  return run(["pull"], void 0, true);
}
async function runLogs(run, service, tail = 200) {
  const invalid = await ensureAllowedServices(run, [service]);
  if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  if (!composeLogsValidateTail(tail)) return { ok: false, stdout: "", stderr: "invalid_tail" };
  return run(["logs", service, "--tail", String(tail)]);
}
async function runAction(run, action, service) {
  const services = Array.isArray(service) ? service : [service];
  if (services.length === 0 && action !== "up") {
    return { ok: false, stdout: "", stderr: "service_not_allowed" };
  }
  if (services.length === 0 && action === "up") {
    return run(["up", "-d", "--remove-orphans"], void 0, true);
  }
  const invalid = await ensureAllowedServices(run, services);
  if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  if (action === "up") return run(["up", "-d", ...services], void 0, true);
  if (action === "stop") return run(["stop", ...services], void 0, true);
  return run(["restart", ...services], void 0, true);
}
async function runConfigServices(run, composeFileOverride) {
  const result = await run(["config", "--services"], composeFileOverride);
  if (!result.ok) throw new Error(result.stderr || "compose_config_services_failed");
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}
async function runExec(run, service, args) {
  if (!service) {
    return run(args, void 0, false);
  }
  const invalid = await ensureAllowedServices(run, [service]);
  if (invalid) return { ok: false, stdout: "", stderr: "service_not_allowed" };
  return run(["exec", "-T", service, ...args], void 0, true);
}
async function allowedServiceSet(runner) {
  const r = runner ?? createComposeRunner();
  const fromCompose = await r.configServices();
  const declared = [...CoreServices, ...extraServicesFromEnv(), ...fromCompose];
  return new Set(declared);
}
async function composeConfigServices(composeFileOverride) {
  return createComposeRunner().configServices(composeFileOverride);
}
async function composeConfigValidate() {
  return createComposeRunner().configValidate();
}
async function composeConfigValidateForFile(composeFile, envFileOverride) {
  return createComposeRunner().configValidateForFile(composeFile, envFileOverride);
}
async function composeList() {
  return createComposeRunner().list();
}
async function composePs() {
  return createComposeRunner().ps();
}
async function composePull(service) {
  return createComposeRunner().pull(service);
}
function composeLogsValidateTail(tail) {
  return Number.isInteger(tail) && tail >= 1 && tail <= 5e3;
}
async function composeLogs(service, tail) {
  return createComposeRunner().logs(service, tail);
}
async function composeServiceNames() {
  return Array.from(await allowedServiceSet()).sort();
}
function filterUiManagedServices(services) {
  const excluded = new Set(UiManagedServiceExclusions);
  return services.filter((service) => !excluded.has(service));
}
async function composeAction(action, service) {
  return createComposeRunner().action(action, service);
}
async function composeStackDown() {
  return createComposeRunner().stackDown();
}
async function composeExec(service, args) {
  return createComposeRunner().exec(service, args);
}
export {
  CoreServices,
  SetupStartupServices,
  UiManagedServiceExclusions,
  allowedServiceSet,
  composeAction,
  composeConfigServices,
  composeConfigValidate,
  composeConfigValidateForFile,
  composeExec,
  composeList,
  composeLogs,
  composeLogsValidateTail,
  composePs,
  composePull,
  composeServiceNames,
  composeStackDown,
  createComposeRunner,
  createMockRunner,
  filterUiManagedServices
};
