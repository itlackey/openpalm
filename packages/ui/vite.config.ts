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
  // Note: the dev-server login-password bridge lives in src/hooks.server.ts
  // (server runtime, where @openpalm/lib is safely importable), not here — the
  // config eval has no Bun shim and shouldn't read secrets.

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
      // evaluate raw `require()` calls). `@openpalm/ui-kit` is raw
      // .svelte/.ts source (no build step) — Node cannot load it, so it
      // must always go through Vite's Svelte pipeline.
      noExternal: mode === "production" ? true : ["yaml", "@openpalm/ui-kit"],
      // SSR-side dep optimizer: esbuild pre-bundles these into ESM so the
      // module runner can evaluate them. Mirrors the client-side
      // optimizeDeps.include below — both lists must include yaml.
      optimizeDeps: {
        include: ["yaml"],
      },
    },
    optimizeDeps: {
      include: ["yaml"],
      // Raw-source Svelte package — esbuild cannot prebundle .svelte files;
      // vite-plugin-svelte compiles it as part of the app instead.
      exclude: ["@openpalm/ui-kit"],
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
            // The shared components moved to @openpalm/ui-kit (P5a, #555);
            // their co-located browser tests still run through THIS project
            // because ui-kit deliberately has no vitest/browser setup of its
            // own (raw-source package, compiled by the consuming app).
            include: [
              "src/**/*.svelte.vitest.{js,ts}",
              "../ui-kit/src/**/*.svelte.vitest.{js,ts}"
            ],
            exclude: ["src/lib/server/**"]
          }
        },

        {
          extends: "./vite.config.ts",
          test: {
            name: "server",
            environment: "node",
            include: ["src/**/*.vitest.{js,ts}", "e2e/**/*.vitest.{js,ts}"],
            exclude: ["src/**/*.svelte.vitest.{js,ts}"],
            // Force a throwaway OP_HOME for every server test run.
            // See src/test-setup-isolation.ts for tripwire logic.
            setupFiles: ["./src/test-setup-isolation.ts"]
          }
        }
      ]
    }
  };
});
