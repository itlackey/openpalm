import { defineConfig } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import devtoolsJson from "vite-plugin-devtools-json";
import { sveltekit } from "@sveltejs/kit/vite";
import { loadEnv } from "vite";
import { resolve } from "node:path";

const rootDir = resolve(__dirname, "../..");

export default defineConfig(({ mode }) => {
  // Load .env from repo root and populate process.env for server-side code
  const env = loadEnv(mode, rootDir, "");

  for (const key in env) {
    process.env[key] ??= env[key];
  }

  return {
    plugins: [sveltekit(), devtoolsJson()],
    envDir: rootDir,
    resolve: {
      alias: {
        "$assets": resolve(__dirname, "../../assets"),
        "$registry": resolve(__dirname, "../../registry"),
        "@openpalm/lib": resolve(__dirname, "../../packages/lib/src")
      }
    },
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
              instances: [{ browser: "chromium", headless: true }]
            },
            include: ["src/**/*.svelte.{test,spec}.{js,ts}"],
            exclude: ["src/lib/server/**"]
          }
        },

        {
          extends: "./vite.config.ts",
          test: {
            name: "server",
            environment: "node",
            include: ["src/**/*.{test,spec}.{js,ts}"],
            exclude: ["src/**/*.svelte.{test,spec}.{js,ts}"]
          }
        }
      ]
    }
  };
});
