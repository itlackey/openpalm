import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ComposeRunner, createComposeRunner } from "./compose-runner.ts";
import { StackManager } from "./stack-manager.ts";

export type StackApplyResult = {
  ok: boolean;
  generated: ReturnType<StackManager["renderPreview"]>;
  caddyReloaded: boolean;
  warnings: string[];
};

/**
 * Applies the current stack spec: render artifacts → validate compose → write files → compose up → caddy reload.
 *
 * When `apply` is false (dry-run), only renders and validates without writing or running compose.
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
  let caddyReloaded = false;

  if (options?.apply ?? true) {
    // Detect caddy config change before writing new artifacts
    const caddyJsonPath = manager.getPaths().caddyJsonPath;
    const existingCaddyJson = existsSync(caddyJsonPath) ? readFileSync(caddyJsonPath, "utf8") : "";
    const caddyChanged = existingCaddyJson !== generated.caddyJson;

    // Write a temp compose file for validation before committing artifacts
    const tempComposePath = join(manager.getPaths().stateRootPath, "docker-compose.yml.next");
    writeFileSync(tempComposePath, generated.composeFile, "utf8");
    const composeValidate = await runner.configValidateForFile(tempComposePath);
    if (!composeValidate.ok) {
      throw new Error(`compose_validation_failed:${composeValidate.stderr}`);
    }

    // Write all artifacts to their live paths
    manager.renderArtifacts(generated);

    // Single compose up -d --remove-orphans (Docker Compose handles change detection)
    const upResult = await runner.action("up", []);
    if (!upResult.ok) throw new Error(`compose_up_failed:${upResult.stderr}`);

    // Caddy uses hot-reload rather than container restart
    if (caddyChanged) {
      const reloadResult = await runner.exec("caddy", ["caddy", "reload", "--config", "/etc/caddy/caddy.json"]);
      if (!reloadResult.ok) throw new Error(`caddy_reload_failed:${reloadResult.stderr}`);
      caddyReloaded = true;
    }
  }

  return { ok: true, generated, caddyReloaded, warnings };
}
