const { spawnSync, spawn } = require("node:child_process");
const { existsSync } = require("node:fs");

// Skip build if SKIP_BUILD is set and build/index.js already exists.
// This lets CI pre-build once and run Playwright without rebuilding,
// and speeds up local iterative development.
const skipBuild = process.env.SKIP_BUILD === "1" && existsSync("build/index.js");

if (!skipBuild) {
	const buildResult = spawnSync("bun", ["run", "build"], { stdio: "inherit" });
	if (buildResult.status !== 0) {
		process.exit(buildResult.status);
	}
}

const server = spawn("bun", ["build/index.js"], { stdio: "inherit" });
const stopServer = () => {
	if (!server.killed) server.kill("SIGTERM");
};
process.on("SIGINT", stopServer);
process.on("SIGTERM", stopServer);
server.on("exit", (code) => {
	process.off("SIGINT", stopServer);
	process.off("SIGTERM", stopServer);
	process.exit(code ?? 1);
});
