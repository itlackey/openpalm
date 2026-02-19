import { describe, expect, it } from "bun:test";
import { getRiskBadge, searchGallery, searchNpm, searchPublicRegistry } from "./gallery.ts";

describe("gallery", () => {
  it("returns all curated items on empty query", () => {
    const all = searchGallery("");
    expect(all.length).toBeGreaterThan(0);
  });

  it("supports searching by text, tags, and category", () => {
    const byName = searchGallery("telemetry");
    expect(byName.some((item) => item.id === "plugin-policy-telemetry")).toBe(true);

    const byTag = searchGallery("security");
    expect(byTag.some((item) => item.id === "plugin-policy-telemetry")).toBe(true);

    const pluginsOnly = searchGallery("", "plugin");
    expect(pluginsOnly.every((item) => item.category === "plugin")).toBe(true);
  });

  it("parses npm search responses", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          objects: [
            {
              package: {
                name: "opencode-awesome-plugin",
                description: "great plugin",
                version: "1.2.3",
                publisher: { username: "openpalm" },
              },
            },
          ],
        })
      )) as unknown as typeof fetch;

    try {
      const results = await searchNpm("awesome");
      expect(results).toEqual([
        {
          name: "opencode-awesome-plugin",
          description: "great plugin",
          version: "1.2.3",
          author: "openpalm",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses community registry cache when network fails", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify([
            {
              id: "community-test",
              name: "Community Test",
              description: "test",
              category: "plugin",
              risk: "low",
              author: "community",
              version: "1.0.0",
              source: "community",
              tags: ["community"],
              permissions: [],
              securityNotes: "",
              installAction: "plugin",
              installTarget: "community-test",
            },
          ])
        );
      }
      throw new Error("network down");
    }) as unknown as typeof fetch;

    try {
      const first = await searchPublicRegistry("community");
      expect(first.length).toBe(1);

      const second = await searchPublicRegistry("community");
      expect(second.length).toBe(1);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns correct risk badge metadata", () => {
    const risk = getRiskBadge("highest");
    expect(risk.label).toBe("Highest Risk");
    expect(risk.color).toBe("#ff3b30");

    const lowest = getRiskBadge("lowest");
    expect(lowest.label).toBe("Lowest Risk");
    expect(lowest.color).toBe("#8e8e93");
  });
});
