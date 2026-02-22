import { statSync } from "node:fs";
import { info } from "@openpalm/lib/ui.ts";

const devDir = ".dev";
const envFile = ".env";

const requiredDirs = [
  "config",
  "data/postgres",
  "data/qdrant",
  "data/openmemory",
  "data/assistant",
  "state/gateway",
  "state/caddy",
  "state/rendered/caddy",
];

export function preflight(): void {
  const issues: string[] = [];

  try {
    statSync(envFile);
  } catch {
    issues.push(`Missing ${envFile}. Run: bun run dev:setup`);
  }

  try {
    statSync(devDir);
  } catch {
    issues.push(`Missing ${devDir}/ directory. Run: bun run dev:setup`);
  }

  if (issues.length === 0) {
    for (const dir of requiredDirs) {
      try {
        statSync(`${devDir}/${dir}`);
      } catch {
        issues.push(`Missing ${devDir}/${dir}. Run: bun run dev:setup`);
        break;
      }
    }
  }

  if (issues.length > 0) {
    throw new Error(`Pre-flight check failed:\n\n${issues.map((issue) => `  - ${issue}`).join("\n")}\n\nRun 'bun run dev:setup' first, then try again.`);
  }

  info("Pre-flight check passed.");
}
