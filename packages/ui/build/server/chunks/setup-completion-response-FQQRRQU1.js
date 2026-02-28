import { a as applyStack } from './stack-apply-engine-CX7GxTsE.js';
import { composeAction, SetupStartupServices } from './compose-runner-BT0hCcoV.js';
import { ensureCoreServicesReady } from './core-readiness-DyKdFkeb.js';
import { syncAutomations } from './automations-CANimQTD.js';
import { u as updateRuntimeEnvContent, p as parseRuntimeEnvContent } from './runtime-env-BS_YlF-D.js';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { setCoreReadinessPhase, applyReadinessResult, getCoreReadinessSnapshot } from './core-readiness-state-jzvT0zEC.js';

function generateToken(length = 64) {
  const bytesNeeded = Math.ceil(length * 3 / 4);
  const randomBytes = new Uint8Array(bytesNeeded);
  crypto.getRandomValues(randomBytes);
  let base64 = btoa(String.fromCharCode(...randomBytes));
  const urlSafeBase64 = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return urlSafeBase64.slice(0, length);
}
const defaultDependencies = {
  secretsEnvPath: "/config/secrets.env",
  existsSync,
  readFileSync,
  parseRuntimeEnvContent,
  updateRuntimeEnvContent,
  generateToken,
  mkdirSync,
  dirname,
  writeFileSync,
  applyStack,
  composeAction,
  syncAutomations,
  ensureCoreServicesReady
};
function ensurePostgresPassword(dependencies) {
  const current = dependencies.existsSync(dependencies.secretsEnvPath) ? dependencies.readFileSync(dependencies.secretsEnvPath, "utf8") : "";
  const existingSecrets = dependencies.parseRuntimeEnvContent(current);
  if (existingSecrets.POSTGRES_PASSWORD) return;
  const next = dependencies.updateRuntimeEnvContent(current, {
    POSTGRES_PASSWORD: dependencies.generateToken(32)
  });
  dependencies.mkdirSync(dependencies.dirname(dependencies.secretsEnvPath), { recursive: true });
  dependencies.writeFileSync(dependencies.secretsEnvPath, next, "utf8");
}
async function completeSetupOrchestration(setupManager, stackManager, overrides = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  ensurePostgresPassword(dependencies);
  setCoreReadinessPhase("applying");
  const apply = await dependencies.applyStack(stackManager);
  setCoreReadinessPhase("starting");
  const startup = await dependencies.composeAction("up", [...SetupStartupServices]);
  if (!startup.ok) {
    setCoreReadinessPhase("failed");
    throw new Error(`core_startup_failed:${startup.stderr}`);
  }
  setCoreReadinessPhase("checking");
  let readiness;
  try {
    const maxAttempts = envInt("CORE_READINESS_MAX_ATTEMPTS", 6);
    const pollIntervalMs = envInt("CORE_READINESS_POLL_MS", 2e3);
    readiness = await dependencies.ensureCoreServicesReady({
      targetServices: SetupStartupServices,
      maxAttempts,
      pollIntervalMs
    });
    applyReadinessResult(readiness);
  } catch {
    setCoreReadinessPhase("failed");
  }
  dependencies.syncAutomations(stackManager.listAutomations());
  const state = setupManager.completeSetup();
  return { state, apply, readiness };
}
function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
async function completeSetupCommandResponse(setupManager, stackManager, secretsEnvPath, completeSetup = completeSetupOrchestration) {
  const result = await completeSetup(setupManager, stackManager, { secretsEnvPath });
  const coreReadiness = getCoreReadinessSnapshot();
  return { ok: true, data: result.state, apply: result.apply, readiness: result.readiness, coreReadiness };
}
async function completeSetupRouteResponse(setupManager, stackManager, secretsEnvPath, completeSetup = completeSetupOrchestration) {
  const result = await completeSetup(setupManager, stackManager, { secretsEnvPath });
  const coreReadiness = getCoreReadinessSnapshot();
  return { ok: true, state: result.state, apply: result.apply, readiness: result.readiness, coreReadiness };
}

export { completeSetupRouteResponse as a, completeSetupCommandResponse as c };
//# sourceMappingURL=setup-completion-response-FQQRRQU1.js.map
