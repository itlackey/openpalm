// Use vite's defineConfig instead of vitest's. Vitest reads the `test` field
// at runtime regardless of how the config is typed, and importing from `vite`
// avoids a known Bun-workspaces issue where vitest installs with different
// optional peer deps in different workspaces produce incompatible type
// universes for `defineConfig`'s `Vitest` generic.
import { defineConfig, loadEnv, type Plugin } from "vite";
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

/**
 * Backport vitest-dev/vitest#10355 while stable Vitest 4 still applies its
 * browser-only dynamic-import wrapper to Vite's SSR environment. Restricting
 * that plugin to `client` is the upstream fix; it keeps SvelteKit's lazy server
 * hook import intact instead of calling an undefined browser runner in Node.
 */
export function isolateVitestBrowserDynamicImports(): Plugin {
  return {
    name: "openpalm:vitest-browser-client-imports",
    configResolved(config) {
      const plugin = config.plugins.find(
        (candidate) => candidate.name === "vitest:browser:esm-injector"
      );
      if (plugin && !plugin.applyToEnvironment) {
        plugin.applyToEnvironment = (environment) => environment.name === "client";
      }
    }
  };
}

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
  const browserExecutablePath = process.env.OP_PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  // Note: the dev-server login-password bridge lives in src/hooks.server.ts
  // (server runtime, where @openpalm/lib is safely importable), not here — the
  // config eval has no Bun shim and shouldn't read secrets.

  return {
    plugins: [sveltekit(), isolateVitestBrowserDynamicImports(), devtoolsJson()],
    envDir: rootDir,
    ssr: {
      // The GitHub host-assets archive and assistant image carry build/ without
      // node_modules, so production builds must inline every SSR dependency.
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
              provider: playwright(
                browserExecutablePath
                  ? { launchOptions: { executablePath: browserExecutablePath } }
                  : {},
              ),
              instances: [{ browser: "chromium", name: "chromium", headless: true }]
            },
            include: [
              "src/**/*.svelte.vitest.{js,ts}",
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
