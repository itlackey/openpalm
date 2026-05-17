import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import devtoolsJson from "vite-plugin-devtools-json";
import { sveltekit } from "@sveltejs/kit/vite";
import { loadEnv } from "vite";
import { resolve } from "node:path";

const rootDir = resolve(__dirname, "../..");

/** Keys whose values are filesystem paths and must be resolved relative to rootDir */
const PATH_KEYS = new Set([
  "OP_HOME",
  "OP_WORK_DIR"
]);

export default defineConfig(({ mode }) => {
  // Load .env from repo root and populate process.env for server-side code.
  // Path values (OP_*_HOME) are resolved relative to rootDir so that
  // the same relative paths used by Docker Compose (e.g. "../.dev/config")
  // work correctly for the Vite dev server regardless of CWD.
  const env = loadEnv(mode, rootDir, "");

  for (const key in env) {
    let value = env[key];
    if (PATH_KEYS.has(key) && value) {
      value = resolve(rootDir, value);
    }
    process.env[key] ??= value;
  }

  return {
    plugins: [sveltekit(), devtoolsJson()],
    envDir: rootDir,
    test: {
      expect: { requireAssertions: true },
      projects: [
        {
          extends: "./vite.config.ts",
          test: {
            name: "client",
            browser: {
              enabled: true,
              provider: playwright(),
              instances: [{ browser: "chromium", name: "chromium", headless: true }]
            },
            include: ["src/**/*.svelte.vitest.{js,ts}"],
            exclude: ["src/lib/server/**"]
          }
        },

        {
          extends: "./vite.config.ts",
          test: {
            name: "server",
            environment: "node",
            include: ["src/**/*.vitest.{js,ts}"],
            exclude: ["src/**/*.svelte.vitest.{js,ts}"]
          }
        }
      ]
    }
  };
});
