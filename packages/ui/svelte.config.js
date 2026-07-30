import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import pkg from "./package.json" with { type: "json" };

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Keep a long-running dev server's route manifest isolated from `check`
    // and `build`, which regenerate the default .svelte-kit directory.
    outDir: process.env.OP_SVELTEKIT_OUT_DIR ?? ".svelte-kit",
    // This app is always served from the origin root. Root-relative assets keep
    // SvelteKit's generated service-worker registration correct on nested URLs.
    paths: { relative: false },
    adapter: adapter({
      out: "build",
      envPrefix: "",
    }),
    version: { name: pkg.version },
    // SvelteKit's own form-CSRF check is disabled (`trustedOrigins: ['*']` is
    // its supported way to say so); `checkOriginHeader` in hooks.server.ts is
    // the single origin gate. This is NOT "no CSRF protection" — every
    // state-changing request still passes the audited check, plus the Host
    // allowlist, and every /api/host route requires a session cookie.
    //
    // The framework check compares Origin against `event.url.origin`, which
    // under adapter-node is the PINNED ORIGIN env value. That made it a fourth,
    // unmanaged gate that contradicted the audited one: our check deliberately
    // accepts SSH tunnels and both loopback spellings, while this one 403'd any
    // form-like POST (multipart/form-data, urlencoded, text/plain) whose browser
    // origin differed from the pin — which is exactly how voice uploads failed
    // through `ssh -L`, while JSON logins sailed through because they are exempt
    // from it. One gate, audited, with tests.
    csrf: { trustedOrigins: ['*'] },
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
        // from the TTS provider can be loaded into <audio>.
        "media-src": ["self", "blob:"],
        // /advanced embeds the active user-selected OpenCode origin. CSP cannot
        // enumerate that runtime value, so permit HTTP(S) frames while keeping
        // every script, connection, object, and base restriction unchanged.
        "frame-src": ["self", "http:", "https:"],
        // The browser fetches the active connection's OpenCode/Guardian baseUrl
        // DIRECTLY (Phase 3b — no host proxy). CSP cannot enumerate that runtime
        // value, so permit HTTP(S) connections while keeping script/object/base
        // restrictions unchanged.
        "connect-src": ["self", "http:", "https:"],
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
