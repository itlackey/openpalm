import { b as building } from "./environment.js";
import { c as createLogger } from "./stack-spec.js";
import { C as COMPOSE_FILE_PATH, D as DATA_ENV_PATH, c as STATE_ROOT, d as SYSTEM_ENV_PATH, R as RUNTIME_ENV_PATH, e as STACK_SPEC_PATH, S as SECRETS_ENV_PATH, f as CONFIG_ROOT, g as DATA_ROOT, h as DATA_DIR, A as ADMIN_TOKEN, i as DEFAULT_INSECURE_TOKEN } from "./config.js";
import "./index.js";
const log = createLogger("admin");
let _setupManager;
let _stackManager;
let _initialized = false;
async function getSetupManager() {
  if (!_setupManager) {
    const { SetupManager } = await import("./setup-manager.js");
    _setupManager = new SetupManager(DATA_DIR, { stackSpecPath: STACK_SPEC_PATH });
  }
  return _setupManager;
}
async function getStackManager() {
  if (!_stackManager) {
    const { StackManager } = await import("./stack-manager.js");
    _stackManager = new StackManager({
      stateRootPath: STATE_ROOT,
      dataRootPath: DATA_ROOT,
      configRootPath: CONFIG_ROOT,
      caddyJsonPath: `${STATE_ROOT}/caddy.json`,
      secretsEnvPath: SECRETS_ENV_PATH,
      stackSpecPath: STACK_SPEC_PATH,
      runtimeEnvPath: RUNTIME_ENV_PATH,
      systemEnvPath: SYSTEM_ENV_PATH,
      gatewayEnvPath: `${STATE_ROOT}/gateway/.env`,
      openmemoryEnvPath: `${STATE_ROOT}/openmemory/.env`,
      postgresEnvPath: `${STATE_ROOT}/postgres/.env`,
      qdrantEnvPath: `${STATE_ROOT}/qdrant/.env`,
      assistantEnvPath: `${STATE_ROOT}/assistant/.env`,
      dataEnvPath: DATA_ENV_PATH,
      composeFilePath: COMPOSE_FILE_PATH
    });
  }
  return _stackManager;
}
async function ensureInitialized() {
  if (_initialized || building) return;
  _initialized = true;
  const sm = await getStackManager();
  const { CORE_AUTOMATIONS } = await import("./index2.js");
  const { ensureCronDirs, syncAutomations, configureCronDir } = await import("./automations.js");
  const { configureCronDir: configureHistoryCronDir } = await import("./automation-history.js");
  const cronDir = `${STATE_ROOT}/automations`;
  configureCronDir(cronDir);
  configureHistoryCronDir(cronDir);
  const spec = sm.getSpec();
  let changed = false;
  for (const core of CORE_AUTOMATIONS) {
    if (!spec.automations.some((a) => a.id === core.id)) {
      spec.automations.push({ ...core, core: true });
      changed = true;
    }
  }
  if (changed) {
    sm.setSpec(spec);
  }
  ensureCronDirs();
  syncAutomations(sm.listAutomations());
  if (ADMIN_TOKEN === DEFAULT_INSECURE_TOKEN) {
    log.warn(
      "Default admin token detected. Set ADMIN_TOKEN environment variable before exposing to network."
    );
  }
}
async function allChannelServiceNames() {
  const sm = await getStackManager();
  return sm.listChannelNames().map((name) => `channel-${name}`);
}
async function allServiceNames() {
  const sm = await getStackManager();
  return sm.listServiceNames().map((name) => `service-${name}`);
}
async function knownServices() {
  const { allowedServiceSet, filterUiManagedServices } = await import("./compose-runner.js");
  const base = await allowedServiceSet();
  for (const svc of await allChannelServiceNames()) base.add(svc);
  for (const svc of await allServiceNames()) base.add(svc);
  return new Set(filterUiManagedServices(Array.from(base)));
}
export {
  getSetupManager as a,
  allChannelServiceNames as b,
  ensureInitialized as e,
  getStackManager as g,
  knownServices as k,
  log as l
};
