import { composeAction, composeConfigValidate, composeServiceNames, composeLogsValidateTail } from "./compose-runner.ts";
import { computeImpactFromChanges, type StackImpact } from "./impact-plan.ts";
import { StackManager } from "./stack-manager.ts";

export type StackApplyResult = {
  ok: boolean;
  generated: ReturnType<StackManager["renderPreview"]>;
  impact: StackImpact;
  warnings: string[];
};

export async function applyStack(manager: StackManager, options?: { apply?: boolean }): Promise<StackApplyResult> {
  const generated = manager.renderPreview();
  const secretErrors = manager.validateEnabledChannelSecrets();
  if (secretErrors.length > 0) {
    throw new Error(`secret_validation_failed:${secretErrors.join(",")}`);
  }

  const warnings: string[] = [];
  if (options?.apply ?? true) {
    const composeValidate = await composeConfigValidate();
    if (!composeValidate.ok) throw new Error(`compose_validation_failed:${composeValidate.stderr}`);

    const caddyConfig = Bun.env.CADDYFILE_PATH ?? "/state/rendered/caddy/Caddyfile";
    const caddyValidate = Bun.spawn(["caddy", "validate", "--config", caddyConfig, "--adapter", "caddyfile"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await caddyValidate.exited;
    if ((caddyValidate.exitCode ?? 1) !== 0) {
      const err = await new Response(caddyValidate.stderr).text();
      warnings.push(`caddy_validate_skipped_or_failed:${err || "caddy_binary_unavailable"}`);
    }
  }

  const impact = computeImpactFromChanges({
    caddyChanged: true,
    gatewaySecretsChanged: true,
    opencodeChanged: true,
  });

  if (options?.apply ?? true) {
    manager.renderArtifacts();
    for (const service of impact.restart) {
      const result = await composeAction("restart", service);
      if (!result.ok) throw new Error(`compose_restart_failed:${service}:${result.stderr}`);
    }
    for (const service of impact.reload) {
      const result = await composeAction("restart", service);
      if (!result.ok) throw new Error(`compose_reload_failed:${service}:${result.stderr}`);
    }
  }

  return { ok: true, generated, impact, warnings };
}

export async function previewComposeOperations(): Promise<{ services: string[]; logTailLimit: boolean }> {
  const names = await composeServiceNames();
  const tailCheck = composeLogsValidateTail(50);
  return { services: names, logTailLimit: tailCheck };
}
