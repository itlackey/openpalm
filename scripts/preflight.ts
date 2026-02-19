import { statSync } from "fs";

const DEV_DIR = ".dev";
const ENV_FILE = ".env";

const requiredDirs = [
  "config/caddy",
  "config/opencode-core",
  "config/channels",
  "data/postgres",
  "data/qdrant",
  "data/openmemory",
  "state/workspace",
  "state/gateway",
];

function check() {
  const issues: string[] = [];

  try {
    statSync(ENV_FILE);
  } catch {
    issues.push(`Missing ${ENV_FILE}. Run: bun run dev:setup`);
  }

  try {
    statSync(DEV_DIR);
  } catch {
    issues.push(`Missing ${DEV_DIR}/ directory. Run: bun run dev:setup`);
  }

  if (issues.length === 0) {
    for (const dir of requiredDirs) {
      try {
        statSync(`${DEV_DIR}/${dir}`);
      } catch {
        issues.push(`Missing ${DEV_DIR}/${dir}. Run: bun run dev:setup`);
        break;
      }
    }
  }

  if (issues.length > 0) {
    console.error("Pre-flight check failed:\n");
    for (const issue of issues) {
      console.error(`  - ${issue}`);
    }
    console.error("\nRun 'bun run dev:setup' first, then try again.");
    process.exit(1);
  }

  console.log("Pre-flight check passed.");
}

check();
