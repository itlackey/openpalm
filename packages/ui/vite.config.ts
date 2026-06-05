// Use vite's defineConfig instead of vitest's. Vitest reads the `test` field
// at runtime regardless of how the config is typed, and importing from `vite`
// avoids a known Bun-workspaces issue where vitest installs with different
// optional peer deps in different workspaces produce incompatible type
// universes for `defineConfig`'s `Vitest` generic.
import { defineConfig, loadEnv } from "vite";
import { playwright } from "@vitest/browser-playwright";
import devtoolsJson from "vite-plugin-devtools-json";
import { sveltekit } from "@sveltejs/kit/vite";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

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

  // Dev-server secret bridge: the production host process (`openpalm ui serve`,
  // see packages/cli/src/lib/ui-server.ts) injects OP_UI_LOGIN_PASSWORD into the
  // UI's env by reading the `op_ui_login_password` file secret. The raw `vite
  // dev` server has no such bridge, so without this the seeded dev password
  // (knowledge/secrets/) never reaches the login route and `bun run ui:dev`
  // login always fails. Mirror the file→env fallback here (dev only).
  if (mode !== "production" && !process.env.VITEST && !process.env.OP_UI_LOGIN_PASSWORD && process.env.OP_HOME) {
    const secret = resolve(process.env.OP_HOME, "knowledge/secrets/op_ui_login_password");
    if (existsSync(secret)) {
      const value = readFileSync(secret, "utf-8").trimEnd();
      if (value) process.env.OP_UI_LOGIN_PASSWORD = value;
    }
  }

  return {
    plugins: [sveltekit(), devtoolsJson()],
    envDir: rootDir,
    ssr: {
      // LOAD-BEARING for the npm publish: @openpalm/ui ships `files:["build"]`
      // with ZERO runtime `dependencies` (they live in devDependencies). That is
      // only safe because `noExternal: true` below inlines every dep into the
      // server chunks. If you ever externalize a runtime dep here, you MUST add
      // it back to `dependencies` in package.json or the published bundle will
      // reference a module that isn't installed on user machines.
      //
      // In PRODUCTION builds we bundle every SSR dep into the server chunks
      // so the build/ directory is self-contained and can be deployed
      // without node_modules (required for state/ui/ deployment).
      //
      // In DEV we externalize most deps — Node handles them natively via
      // require interop, and Vite's ESM-only module runner doesn't have
      // to evaluate CJS packages itself. Only `yaml` is force-bundled
      // because the server code does `import { parse } from 'yaml'`
      // directly and yaml@2.x ships pure CJS (Vite's ESM runner can't
      // evaluate raw `require()` calls).
      noExternal: mode === "production" ? true : ["yaml"],
      // SSR-side dep optimizer: esbuild pre-bundles these into ESM so the
      // module runner can evaluate them. Mirrors the client-side
      // optimizeDeps.include below — both lists must include yaml.
      optimizeDeps: {
        include: ["yaml"],
      },
    },
    optimizeDeps: {
      include: ["yaml"],
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
