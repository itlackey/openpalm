import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const STACK_ENV = resolve(REPO_ROOT, ".dev/state/artifacts/stack.env");
const BACKUP = `${STACK_ENV}.e2e-backup`;

export default async function globalSetup() {
	if (!existsSync(STACK_ENV)) return;
	const content = readFileSync(STACK_ENV, "utf8");
	writeFileSync(BACKUP, content);
	writeFileSync(
		STACK_ENV,
		content.replace(
			/^OPENPALM_SETUP_COMPLETE=true$/m,
			"OPENPALM_SETUP_COMPLETE=false"
		)
	);
}
