import { u as unauthorizedJson, j as json, e as errorJson } from "../../../../chunks/json.js";
import { g as getStackManager } from "../../../../chunks/init.js";
import { a as applyStack } from "../../../../chunks/stack-apply-engine.js";
import { composeAction, composeExec } from "../../../../chunks/compose-runner.js";
import { syncAutomations } from "../../../../chunks/automations.js";
import { existsSync, readFileSync } from "node:fs";
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
export {
  POST
};
