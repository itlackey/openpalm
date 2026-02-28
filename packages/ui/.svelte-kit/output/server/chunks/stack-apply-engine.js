import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createComposeRunner } from "./compose-runner.js";
import { u as updateRuntimeEnvContent } from "./runtime-env.js";
async function applyStack(manager, options) {
  const runner = options?.runner ?? createComposeRunner(manager.getPaths().runtimeEnvPath);
  const generated = manager.renderPreview();
  const secretErrors = manager.validateReferencedSecrets();
  if (secretErrors.length > 0) {
    throw new Error(`secret_validation_failed:${secretErrors.join(",")}`);
  }
  const warnings = [];
  if (options?.apply ?? true) {
    const runtimeEnvPath = manager.getPaths().runtimeEnvPath;
    const existingRuntime = existsSync(runtimeEnvPath) ? readFileSync(runtimeEnvPath, "utf8") : "";
    const updatedRuntime = updateRuntimeEnvContent(existingRuntime, manager.getRuntimeEnvEntries());
    mkdirSync(dirname(runtimeEnvPath), { recursive: true });
    writeFileSync(runtimeEnvPath, updatedRuntime, "utf8");
    const tempComposePath = join(manager.getPaths().stateRootPath, "docker-compose.yml.next");
    writeFileSync(tempComposePath, generated.composeFile, "utf8");
    const composeValidate = await runner.configValidateForFile(tempComposePath);
    if (!composeValidate.ok) {
      throw new Error(`compose_validation_failed:${composeValidate.stderr}`);
    }
    manager.renderArtifacts(generated);
  }
  return { ok: true, generated, warnings };
}
export {
  applyStack as a
};
