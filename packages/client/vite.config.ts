import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  optimizeDeps: {
    // Raw-source Svelte package — esbuild cannot prebundle .svelte files;
    // vite-plugin-svelte compiles it as part of the app instead (same
    // arrangement as packages/ui).
    exclude: ["@openpalm/ui-kit"],
  },
});
