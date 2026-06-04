import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import pkg from "./package.json" with { type: "json" };

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      out: "build",
      envPrefix: "",
    }),
    version: { name: pkg.version },
    // CSP — enforced from day one (not Report-Only). SvelteKit emits a
    // <meta http-equiv="Content-Security-Policy"> tag with auto-computed
    // hashes for the inline hydration scripts it injects. Without 'hash'
    // mode, `script-src 'self'` blocks SvelteKit's own bootstrap.
    //
    // X-Frame-Options: DENY is set in hooks.server.ts as a header backup
    // for `frame-ancestors 'none'`, which is silently ignored when set via
    // <meta> (per CSP spec). Both layers cover clickjacking.
    csp: {
      mode: "hash",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        // Google Fonts (CSS + woff2). Inline styles allowed because Svelte
        // style scoping + theme tokens emit small inline blocks. The load-
        // bearing XSS protection is script-src, not style-src.
        "style-src": ["self", "unsafe-inline", "https://fonts.googleapis.com"],
        "font-src": ["self", "https://fonts.gstatic.com"],
        "img-src": ["self", "data:"],
        // Voice TTS playback uses `new Audio(URL.createObjectURL(blob))`.
        // Without an explicit media-src directive, CSP falls back to
        // default-src 'self' which blocks blob: URIs and the audio element
        // refuses to play. Allow self + blob: so MP3/WAV responses streamed
        // from /api/speak can be loaded into <audio>.
        "media-src": ["self", "blob:"],
        // The /advanced page embeds the OpenCode web UI in an iframe. OpenCode
        // is bound host-only (127.0.0.1:<assistant port>, default 3800), so the
        // embed only ever loads over localhost from the operator's own machine —
        // allow exactly that. frame-src governs ONLY iframe sources; it does not
        // relax script-src/connect-src (the load-bearing XSS protections).
        "frame-src": [
          "self",
          "http://localhost:*",
          "http://127.0.0.1:*",
          "https://localhost:*",
          "https://127.0.0.1:*",
        ],
        "connect-src": ["self"],
        "object-src": ["none"],
        "base-uri": ["none"],
        // `frame-ancestors` is silently ignored in <meta>; X-Frame-Options
        // header in hooks.server.ts is the actual enforcement.
        "frame-ancestors": ["none"],
      },
    },
  }
};

export default config;
