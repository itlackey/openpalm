import { u as unauthorizedJson, j as json, e as errorJson } from './json-juD_ypql.js';
import { a as getStackManager } from './init-C6nnJEAN.js';
import { a as applyStack } from './stack-apply-engine-CX7GxTsE.js';
import { composeAction, composeExec } from './compose-runner-BT0hCcoV.js';
import { syncAutomations } from './automations-CANimQTD.js';
import { existsSync, readFileSync } from 'node:fs';
import './index-CoD1IJuy.js';
import './environment-DsMNyocV.js';
import './stack-spec-DIyG4On0.js';
import 'node:path';
import './index-CyXiysyI.js';
import './config-B06wMz0z.js';
import './shared-server-DaWdgxVh.js';
import './runtime-env-BS_YlF-D.js';
import 'node:child_process';
import './cron-Dh4kQz92.js';

const POST = async ({ locals }) => {
  if (!locals.authenticated) return unauthorizedJson();
  const stackManager = await getStackManager();
  try {
    const caddyJsonPath = stackManager.getPaths().caddyJsonPath;
    const existingCaddyJson = existsSync(caddyJsonPath) ? readFileSync(caddyJsonPath, "utf8") : "";
    const result = await applyStack(stackManager);
    const upResult = await composeAction("up", []);
    if (!upResult.ok) throw new Error(`compose_up_failed:${upResult.stderr}`);
    if (existingCaddyJson !== result.generated.caddyJson) {
      await composeExec("caddy", ["caddy", "reload", "--config", "/etc/caddy/caddy.json"]).catch(() => {
      });
    }
    syncAutomations(stackManager.listAutomations());
    return json(200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("secret_validation_failed:")) {
      return errorJson(
        400,
        "secret_reference_validation_failed",
        message.replace("secret_validation_failed:", "").split(",")
      );
    }
    return errorJson(500, "stack_apply_failed", message);
  }
};

export { POST };
//# sourceMappingURL=_server.ts-CaXdn1sb.js.map
