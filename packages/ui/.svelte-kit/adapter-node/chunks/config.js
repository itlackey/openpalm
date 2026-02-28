import { b as private_env } from "./shared-server.js";
function devDefault(envVar, dockerDefault, devRelative) {
  const value = private_env[envVar];
  if (value) return value;
  return dockerDefault;
}
Number(private_env.PORT ?? 8100);
const ADMIN_TOKEN = private_env.ADMIN_TOKEN ?? "change-me-admin-token";
const DEFAULT_INSECURE_TOKEN = "change-me-admin-token";
const DATA_ROOT = devDefault("OPENPALM_DATA_ROOT", "/data");
const CONFIG_ROOT = devDefault("OPENPALM_CONFIG_ROOT", "/config");
const STATE_ROOT = devDefault("OPENPALM_STATE_ROOT", "/state");
const OPENCODE_CONFIG_PATH = private_env.OPENCODE_CONFIG_PATH ?? `${DATA_ROOT}/assistant/.config/opencode/opencode.json`;
const DATA_DIR = private_env.DATA_DIR ?? `${DATA_ROOT}/admin`;
const GATEWAY_URL = devDefault("GATEWAY_URL", "http://gateway:8080");
const OPENPALM_ASSISTANT_URL = devDefault(
  "OPENPALM_ASSISTANT_URL",
  "http://assistant:4096"
);
const OPENMEMORY_URL = devDefault(
  "OPENMEMORY_URL",
  "http://openmemory:8765"
);
const RUNTIME_ENV_PATH = `${STATE_ROOT}/.env`;
const SECRETS_ENV_PATH = `${CONFIG_ROOT}/secrets.env`;
const STACK_SPEC_PATH = `${CONFIG_ROOT}/openpalm.yaml`;
const COMPOSE_FILE_PATH = `${STATE_ROOT}/docker-compose.yml`;
const SYSTEM_ENV_PATH = `${STATE_ROOT}/system.env`;
const DATA_ENV_PATH = `${DATA_ROOT}/.env`;
export {
  ADMIN_TOKEN as A,
  COMPOSE_FILE_PATH as C,
  DATA_ENV_PATH as D,
  GATEWAY_URL as G,
  OPENPALM_ASSISTANT_URL as O,
  RUNTIME_ENV_PATH as R,
  SECRETS_ENV_PATH as S,
  OPENMEMORY_URL as a,
  OPENCODE_CONFIG_PATH as b,
  STATE_ROOT as c,
  SYSTEM_ENV_PATH as d,
  STACK_SPEC_PATH as e,
  CONFIG_ROOT as f,
  DATA_ROOT as g,
  DATA_DIR as h,
  DEFAULT_INSECURE_TOKEN as i
};
