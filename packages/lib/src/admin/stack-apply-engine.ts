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

export async function applyStack(manager: StackManager, options?: { apply?: boolean; runner?: ComposeRunner }): Promise<StackApplyResult> {
  const runner = options?.runner ?? createComposeRunner(manager.getPaths().runtimeEnvPath);
  const generated = manager.renderPreview();

  const secretErrors = manager.validateReferencedSecrets();
  if (secretErrors.length > 0) throw new Error(`secret_validation_failed:${secretErrors.join(",")}`);

  if (options?.apply ?? true) {
    const runtimeEnvPath = manager.getPaths().runtimeEnvPath;
    const existingRuntime = existsSync(runtimeEnvPath) ? readFileSync(runtimeEnvPath, "utf8") : "";
    mkdirSync(dirname(runtimeEnvPath), { recursive: true });
    writeFileSync(runtimeEnvPath, updateRuntimeEnvContent(existingRuntime, manager.getRuntimeEnvEntries()), "utf8");

    const tempComposePath = join(manager.getPaths().stateRootPath, "docker-compose.yml.next");
    writeFileSync(tempComposePath, generated.composeFile, "utf8");
    const composeValidate = await runner.configValidateForFile(tempComposePath);
    if (!composeValidate.ok) throw new Error(`compose_validation_failed:${composeValidate.stderr}`);

    manager.renderArtifacts(generated);
  }

  return { ok: true, generated, warnings: [] };
}
