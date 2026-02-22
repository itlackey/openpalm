const { existsSync } = require("node:fs");
const { spawnSync, spawn } = require("node:child_process");

if (!existsSync("build/index.js")) {
	const buildResult = spawnSync("npm", ["run", "build"], { stdio: "inherit" });
	if (buildResult.status !== 0) {
		process.exit(buildResult.status);
	}
}

const server = spawn("node", ["build/index.js"], { stdio: "inherit" });
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
