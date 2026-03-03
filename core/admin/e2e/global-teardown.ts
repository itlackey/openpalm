import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const STACK_ENV = resolve(REPO_ROOT, ".dev/state/artifacts/stack.env");
const BACKUP = `${STACK_ENV}.e2e-backup`;

export default async function globalTeardown() {
	if (!existsSync(BACKUP)) return;
	writeFileSync(STACK_ENV, readFileSync(BACKUP, "utf8"));
	unlinkSync(BACKUP);
}
