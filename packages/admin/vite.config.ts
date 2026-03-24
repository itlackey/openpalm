import { defineConfig, type Plugin } from "vitest/config";
import { playwright } from "@vitest/browser-playwright";
import devtoolsJson from "vite-plugin-devtools-json";
import { sveltekit } from "@sveltejs/kit/vite";
import { loadEnv } from "vite";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const rootDir = resolve(__dirname, "../..");

/**
 * Handle Bun-style text imports: `import x from "./file" with { type: "text" }`.
 * Vite/Rollup doesn't natively support import attributes for arbitrary files.
 * This plugin intercepts these imports and returns the file content as a string.
 */
function bunTextImport(): Plugin {
  return {
    name: "bun-text-import",
    enforce: "pre",
    resolveId(source, importer, options) {
      if ((options as any)?.attributes?.type === "text" || (options as any)?.with?.type === "text") {
        return this.resolve(source, importer, { skipSelf: true }).then(
          (resolved) => resolved ? { id: resolved.id + "?bun-text", external: false } : null
        );
      }
      return null;
    },
    load(id) {
      if (id.endsWith("?bun-text")) {
        const filePath = id.slice(0, -"?bun-text".length);
        const content = readFileSync(filePath, "utf-8");
        return `export default ${JSON.stringify(content)};`;
      }
      return null;
    },
  };
}

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
    plugins: [bunTextImport(), sveltekit(), devtoolsJson()],
    envDir: rootDir,
    resolve: {
      alias: {
        "$stack": resolve(__dirname, "../../.openpalm/stack"),
        "$config": resolve(__dirname, "../../.openpalm/config"),
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
              instances: [{ browser: "chromium", name: "chromium", headless: true }]
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
