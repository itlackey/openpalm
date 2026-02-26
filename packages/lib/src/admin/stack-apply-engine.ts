import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ComposeRunner, createComposeRunner } from "./compose-runner.ts";
import { StackManager } from "./stack-manager.ts";
import { updateRuntimeEnvContent } from "./runtime-env.ts";

type StackApplyResult = {
  ok: boolean;
  generated: ReturnType<StackManager["renderPreview"]>;
  warnings: string[];
};

/**
 * Applies the current stack spec: render artifacts → validate compose → write files.
 *
 * Does NOT run `compose up` — the caller is responsible for starting services after
 * calling this function. This keeps applyStack a pure render+validate+write step and
 * lets callers decide which services to start (and with which compose file).
 *
 * When `apply` is false (dry-run), only renders and validates without writing.
 */
export async function applyStack(manager: StackManager, options?: { apply?: boolean; runner?: ComposeRunner }): Promise<StackApplyResult> {
  const runner = options?.runner ?? createComposeRunner(manager.getPaths().runtimeEnvPath);
  const generated = manager.renderPreview();

  // Validate secret references before any side effects
  const secretErrors = manager.validateReferencedSecrets();
  if (secretErrors.length > 0) {
    throw new Error(`secret_validation_failed:${secretErrors.join(",")}`);
  }

  const warnings: string[] = [];

  if (options?.apply ?? true) {
    // Write host-side path vars to runtimeEnvPath BEFORE compose validation so that
    // docker compose can interpolate ${OPENPALM_STATE_HOME} etc. in the generated file.
    // This is a no-op if already correct (updateRuntimeEnvContent is idempotent).
    const runtimeEnvPath = manager.getPaths().runtimeEnvPath;
    const existingRuntime = existsSync(runtimeEnvPath) ? readFileSync(runtimeEnvPath, "utf8") : "";
    const updatedRuntime = updateRuntimeEnvContent(existingRuntime, manager.getRuntimeEnvEntries());
    mkdirSync(dirname(runtimeEnvPath), { recursive: true });
    writeFileSync(runtimeEnvPath, updatedRuntime, "utf8");

    // Write a temp compose file for validation before committing artifacts
    const tempComposePath = join(manager.getPaths().stateRootPath, "docker-compose.yml.next");
    writeFileSync(tempComposePath, generated.composeFile, "utf8");
    const composeValidate = await runner.configValidateForFile(tempComposePath);
    if (!composeValidate.ok) {
      throw new Error(`compose_validation_failed:${composeValidate.stderr}`);
    }

    // Write all artifacts to their live paths
    manager.renderArtifacts(generated);
  }

  return { ok: true, generated, warnings };
}
