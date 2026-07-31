import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Only the test/ directory.
    include: ["test/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
