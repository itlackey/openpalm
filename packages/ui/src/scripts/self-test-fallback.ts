import { join } from "node:path";
import { StackManager } from "../../../lib/src/admin/stack-manager.ts";
import { selfTestFallbackBundle } from "../../../lib/src/admin/stack-apply-engine.ts";

const stateRootPath = process.env.OPENPALM_STATE_HOME ?? "/state";
const configRootPath = process.env.OPENPALM_CONFIG_HOME ?? "/config";

const manager = new StackManager({
  stateRootPath,
  caddyJsonPath: join(stateRootPath, "caddy.json"),
  composeFilePath: join(stateRootPath, "docker-compose.yml"),
  systemEnvPath: join(stateRootPath, "system.env"),
  secretsEnvPath: join(configRootPath, "secrets.env"),
  stackSpecPath: join(stateRootPath, "openpalm.yaml"),
  gatewayEnvPath: join(stateRootPath, "gateway", ".env"),
  openmemoryEnvPath: join(stateRootPath, "openmemory", ".env"),
  postgresEnvPath: join(stateRootPath, "postgres", ".env"),
  qdrantEnvPath: join(stateRootPath, "qdrant", ".env"),
  assistantEnvPath: join(stateRootPath, "assistant", ".env"),
  fallbackComposeFilePath: join(stateRootPath, "docker-compose-fallback.yml"),
  fallbackCaddyJsonPath: join(stateRootPath, "caddy-fallback.json"),
});

const result = await selfTestFallbackBundle(manager);
if (!result.ok) {
  console.warn(`Fallback bundle self-test failed: ${result.errors.join(",")}`);
}
