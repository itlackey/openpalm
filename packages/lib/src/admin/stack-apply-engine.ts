import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  composeActionWithOverride,
  composeConfigValidateForFileWithOverride,
  composeExecWithOverride,
} from "./compose-runner.ts";
import { StackManager } from "./stack-manager.ts";

export type StackApplyResult = {
  ok: boolean;
  generated: ReturnType<StackManager["renderPreview"]>;
  caddyReloaded: boolean;
  warnings: string[];
};

export async function applyStack(manager: StackManager, options?: { apply?: boolean }): Promise<StackApplyResult> {
  const generated = manager.renderPreview();
  const secretErrors = manager.validateReferencedSecrets();
  if (secretErrors.length > 0) {
    throw new Error(`secret_validation_failed:${secretErrors.join(",")}`);
  }

  const warnings: string[] = [];
  let caddyReloaded = false;
  const applyLockPath = manager.getPaths().applyLockPath ?? join(manager.getPaths().stateRootPath, "apply.lock");

  if (options?.apply ?? true) {
    acquireApplyLock(applyLockPath, 10 * 60_000);

    try {
      // Detect caddy config change before writing new artifacts
      const caddyJsonPath = manager.getPaths().caddyJsonPath;
      const existingCaddyJson = existsSync(caddyJsonPath) ? readFileSync(caddyJsonPath, "utf8") : "";
      const caddyChanged = existingCaddyJson !== generated.caddyJson;

      const staged = manager.renderArtifactsToTemp(generated, { transactionId: randomUUID() });
      const composeValidate = await composeConfigValidateForFileWithOverride(staged.composeFilePath);
      if (!composeValidate.ok) {
        staged.cleanup();
        throw new Error(`compose_validation_failed:${composeValidate.stderr}`);
      }
      staged.promote();

      // Single compose up -d --remove-orphans (Docker Compose handles change detection)
      const upResult = await composeActionWithOverride("up", []);
      if (!upResult.ok) throw new Error(`compose_up_failed:${upResult.stderr}`);

      // Caddy uses hot-reload rather than container restart
      if (caddyChanged) {
        const reloadResult = await composeExecWithOverride("caddy", ["caddy", "reload", "--config", "/etc/caddy/caddy.json"]);
        if (!reloadResult.ok) throw new Error(`caddy_reload_failed:${reloadResult.stderr}`);
        caddyReloaded = true;
      }

      staged.cleanup();
    } catch (error) {
      throw error;
    } finally {
      releaseApplyLock(applyLockPath);
    }
  }

  return { ok: true, generated, caddyReloaded, warnings };
}

function acquireApplyLock(lockPath: string, timeoutMs: number): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const content = readFileSync(lockPath, "utf8");
    const parsed = parseLockContent(content);
    if (parsed && Date.now() - parsed.timestamp < timeoutMs) {
      throw new Error("apply_lock_held");
    }
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, timestamp: Date.now() }) + "\n", "utf8");
}

function releaseApplyLock(lockPath: string): void {
  if (existsSync(lockPath)) rmSync(lockPath, { force: true });
}

function parseLockContent(content: string): { pid: number; timestamp: number } | null {
  try {
    const parsed = JSON.parse(content) as { pid: number; timestamp: number };
    if (typeof parsed.pid !== "number" || typeof parsed.timestamp !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}
