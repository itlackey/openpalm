import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PAPERCLIP_UPSTREAM_VERSION } from './paperclip.js';
import { BUILTIN_ADDON_ENV_SCHEMAS } from './addon-env-schemas.js';

const repoRoot = resolve(import.meta.dir, '../../../..');
const dockerfile = readFileSync(join(repoRoot, 'containers/paperclip/Dockerfile'), 'utf8');
const composeYml = readFileSync(
	join(repoRoot, 'packages/skeleton/system/stack/services.compose.yml'),
	'utf8'
);

/**
 * These tests deliberately avoid the "assert the Dockerfile contains the
 * strings the Dockerfile contains" shape. That shape cannot fail unless
 * someone edits the file it reads, and it passed at full green while the
 * image shipped with no agent CLIs at all. Each test below encodes a property
 * a plausible edit can actually violate.
 *
 * On the ENTRYPOINT assertion below: an earlier revision asserted
 * `not.toMatch(/ENTRYPOINT/)` while the secret-boundary question was still
 * open, which meant it forbade the one mechanism available to fix a known
 * defect. That question is now decided — image purity is the preferred
 * trade-off (PR #599 review) — so the assertion is back, but as a recorded
 * decision with its cost stated rather than an unexplained prohibition.
 */
describe('Paperclip image contract', () => {
	test('packages the pinned upstream release and adds no OpenPalm code', () => {
		expect(dockerfile).toContain(`ARG PAPERCLIP_VERSION=${PAPERCLIP_UPSTREAM_VERSION}`);
		expect(dockerfile).toContain('npm install --global --omit=dev');
		expect(dockerfile).toContain('prepareEmbeddedPostgresNativeRuntime');
	});

	test('holds the image-purity constraint, whose accepted cost is the env_file exemption', () => {
		// DECIDED TRADE-OFF, not an accident. This image packages the upstream
		// release and nothing else: no adapter, no verifier, no wrapper
		// entrypoint, no copied-in OpenPalm files.
		//
		// The cost is real and is accepted deliberately: upstream reads
		// BETTER_AUTH_SECRET and PAPERCLIP_TOOL_ACTION_SIGNING_SECRET from
		// process.env only, with no *_FILE indirection, so those two values
		// reach the container as environment via the audited
		// private/env/paperclip.env exemption (see core-principles.md § Private
		// credentials). Delivering them as file secrets instead would require an
		// exec wrapper — precisely the OpenPalm-authored code this constraint
		// excludes. Changing this test means re-opening that trade-off, not
		// working around it.
		expect(dockerfile).not.toContain('packages/paperclip-adapter');
		expect(dockerfile).not.toContain('verifier');
		expect(dockerfile).not.toMatch(/^\s*ENTRYPOINT/m);
		// No local build context is copied in — the image is composed purely
		// from published packages.
		expect(dockerfile).not.toMatch(/^\s*COPY\s/m);
	});

	test('the upstream version agrees across every file that repeats it', () => {
		expect(composeYml).toContain(`\${OP_PAPERCLIP_VERSION:-${PAPERCLIP_UPSTREAM_VERSION}}`);
		expect(BUILTIN_ADDON_ENV_SCHEMAS.paperclip).toContain(
			`OP_PAPERCLIP_VERSION=${PAPERCLIP_UPSTREAM_VERSION}`
		);
	});

	test('bakes every agent CLI the built-in local adapters spawn by bare name', () => {
		// @paperclipai/server dist/adapters/registry.js spawns claude/codex/
		// opencode/gemini by bare name. Missing binaries fail at agent-run time
		// while /api/health still returns 200, so the image is the only place
		// this is catchable.
		for (const pkg of [
			'@anthropic-ai/claude-code@',
			'@openai/codex@',
			'opencode-ai@',
			'@google/gemini-cli@'
		]) {
			expect(dockerfile).toContain(pkg);
		}
		expect(dockerfile).toContain('for bin in claude codex opencode gemini');
	});

	test('keeps opencode-ai in lockstep with the assistant image', () => {
		// AGENTS.md requires the assistant and guardian OpenCode pins stay in
		// lockstep; this image is now the third consumer of that rule.
		const assistantTools = JSON.parse(
			readFileSync(join(repoRoot, 'containers/assistant/tools/package.json'), 'utf8')
		) as { dependencies?: Record<string, string> };
		const pinned = assistantTools.dependencies?.['opencode-ai'];
		expect(pinned).toBeTruthy();
		expect(dockerfile).toContain(`ARG OPENCODE_VERSION=${pinned}`);
	});

	test('asserts the server entry path at build time', () => {
		// CMD hardcodes an npm-hoisting-dependent path. It resolves today, but
		// hoisting is an npm implementation detail, not a contract — the build
		// must fail loudly if it ever moves, rather than the first agent run.
		expect(dockerfile).toContain(
			'test -f /usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/server/dist/index.js'
		);
	});
});
