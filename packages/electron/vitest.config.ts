import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only the test/ directory — admin-tools/test/ uses bun:test and must run
    // under `bun test`, not vitest. See packages/electron/admin-tools/package.json.
    include: ["test/**/*.test.ts"],
    exclude: ["admin-tools/**", "dist/**", "node_modules/**"],
  },
});
