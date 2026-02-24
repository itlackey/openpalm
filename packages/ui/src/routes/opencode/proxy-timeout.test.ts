import { describe, expect, it } from "bun:test";
import { generateStackArtifacts } from "../../../../lib/src/admin/stack-generator.ts";
import { createDefaultStackSpec } from "../../../../lib/src/admin/stack-spec.ts";

/**
 * ISSUE-7: SvelteKit proxy cannot handle WebSocket or SSE
 *
 * 7.1 — Caddy natively handles WS/SSE via the /services/opencode* route (ISSUE-6).
 * 7.2 — The SvelteKit proxy timeout was raised from 5s to 5 minutes.
 */
describe("ISSUE-7 – proxy timeout and Caddy WS/SSE support", () => {
	// ── ISSUE-7.2: SvelteKit proxy uses 5-minute timeout ──────────────

	it("has a 300_000ms (5-minute) abort timeout", async () => {
		const source = await Bun.file(
			new URL("./[...path]/+server.ts", import.meta.url),
		).text();
		expect(source).toContain("AbortSignal.timeout(300_000)");
	});

	it("does not contain the old 5-second timeout", async () => {
		const source = await Bun.file(
			new URL("./[...path]/+server.ts", import.meta.url),
		).text();
		expect(source).not.toContain("AbortSignal.timeout(5000)");
	});

	// ── ISSUE-7.1: Caddy route for /services/opencode* exists ─────────

	it("generates a Caddy route for /services/opencode*", () => {
		const spec = createDefaultStackSpec();
		const artifacts = generateStackArtifacts(spec, {});

		// The generated Caddy JSON must contain the opencode proxy path.
		// A simple string check is sufficient and avoids brittle structure coupling.
		expect(artifacts.caddyJson).toContain("/services/opencode*");
	});
});
