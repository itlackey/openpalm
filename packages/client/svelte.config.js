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
    serviceWorker: {
      register: false,
    },
    version: { name: pkg.version },
    csp: {
      mode: 'hash',
      directives: {
        'default-src': ['self'],
        'script-src': ['self'],
        // H4 (review 2026-07-10 §H4): fonts are self-hosted under
        // static/fonts — no external font origin needed any more.
        'style-src': ['self', 'unsafe-inline'],
        'font-src': ['self'],
        'img-src': ['self', 'data:'],
        'connect-src': ['self', 'http:', 'https:'],
        // Advanced mode embeds the active connection selected from IndexedDB.
        // Its origin is not known at build time; this relaxes frames only.
        'frame-src': ['self', 'http:', 'https:'],
        'object-src': ['none'],
        'base-uri': ['none'],
        'frame-ancestors': ['none'],
      },
    },
  },
};

export default config;
