import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import pkg from "./package.json" with { type: "json" };

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Pure SPA (plan ui-runtime-modes-plan.md §6.10/§6.11): every route is
    // client-rendered (ssr=false in routes/+layout.ts) and the adapter emits
    // an index.html fallback so any static file server — bin/serve.mjs, the
    // assistant container co-process (#510), or a CDN — can serve deep links.
    adapter: adapter({
      pages: "build",
      assets: "build",
      fallback: "index.html",
    }),
    version: { name: pkg.version },
  },
};

export default config;
