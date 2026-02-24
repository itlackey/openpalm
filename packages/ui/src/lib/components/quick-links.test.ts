import { describe, expect, it } from "bun:test";
import { generateStackArtifacts } from "../../../../lib/src/admin/stack-generator.ts";
import { createDefaultStackSpec } from "../../../../lib/src/admin/stack-spec.ts";

const svelteFile = new URL("./QuickLinks.svelte", import.meta.url).pathname;

describe("QuickLinks assistantUrl (ISSUE-6)", () => {
  it("uses /services/opencode/ as the assistant URL", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("/services/opencode/");
  });

  it("does not use the old base-relative opencode URL", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).not.toContain("${base}/opencode/");
  });

  it("has a Caddy route for /services/opencode* in the generated stack", () => {
    const spec = createDefaultStackSpec();
    const out = generateStackArtifacts(spec, {});
    const caddyConfig = JSON.parse(out.caddyJson);
    const routes = caddyConfig.apps.http.servers.main.routes;

    // Flatten all path matchers across routes and subroutes
    const allPaths: string[] = [];
    for (const route of routes) {
      if (Array.isArray(route.match)) {
        for (const m of route.match) {
          if (Array.isArray(m.path)) allPaths.push(...m.path);
        }
      }
      if (Array.isArray(route.handle)) {
        for (const h of route.handle) {
          if (h.handler === "subroute" && Array.isArray(h.routes)) {
            for (const sub of h.routes) {
              if (Array.isArray(sub.match)) {
                for (const m of sub.match) {
                  if (Array.isArray(m.path)) allPaths.push(...m.path);
                }
              }
            }
          }
        }
      }
    }

    expect(allPaths).toContain("/services/opencode*");
  });
});

describe("QuickLinks uninstall link (ISSUE-17)", () => {
  it("includes an uninstall documentation link", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("Uninstall");
    expect(content).toContain("maintenance.md#uninstalling");
  });

  it("links to the GitHub docs for uninstall", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("github.com/itlackey/openpalm");
    expect(content).toContain("uninstalling");
  });

  it("has descriptive text about removing OpenPalm", async () => {
    const content = await Bun.file(svelteFile).text();
    expect(content).toContain("remove OpenPalm");
  });
});
