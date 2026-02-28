import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "./package.json" with { type: "json" };

const __dirname = fileURLToPath(new URL(".", import.meta.url));

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    version: { name: pkg.version },
    alias: {
      "@openpalm/lib/*": resolve(__dirname, "../../packages/lib/src/*")
    }
  }
};

export default config;
