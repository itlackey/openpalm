import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ADVANCED_PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));
const CHAT_NAVBAR = fileURLToPath(
	new URL('../../lib/components/chrome/ChatNavbar.svelte', import.meta.url),
);

describe('Advanced fallback coherence', () => {
	test('uses the shared chat header and makes the page inert while its drawer is open', () => {
		const source = readFileSync(ADVANCED_PAGE, 'utf8');

		expect(source).toMatch(
			/<ChatNavbar bind:drawerOpen=\{navigationOpen\} bind:activityRailOpen\s*\/>/
		);
		expect(source).toMatch(/<div class="advanced-layout" inert=\{navigationOpen\}>/);
		expect(source).toMatch(/height:\s*calc\(100dvh - 64px\)/);
		expect(source).toMatch(/height:\s*calc\(100dvh - 112px\)/);
	});

	test('keeps Activity available through the shared header at mobile widths', () => {
		const source = readFileSync(CHAT_NAVBAR, 'utf8');

		expect(source).toMatch(/Activity/);
		expect(source).toMatch(/drawerOpen/);
		expect(source).not.toMatch(
			/@media\s*\([^)]*max-width[^)]*\)[\s\S]*?activity[^}]*display:\s*none/i,
		);
	});

	test('activates only the exact assistant requested by the route before resolving it', () => {
		const source = readFileSync(ADVANCED_PAGE, 'utf8');

		expect(source).toMatch(/searchParams\.get\('assistant'\)/);
		expect(source).toMatch(
			/endpointsService\.endpoints\.find\(\(connection\) => connection\.id === requestedAssistantId\)/,
		);
		expect(source).toMatch(
			/await endpointsService\.activate\(requestedAssistant\.id\)[\s\S]*?await resolve\(/,
		);
		expect(source).toMatch(/buildAdvancedPath\(chat\.activeSessionId, assistantId\)/);
	});

	test('shows one shared desktop Activity rail for the parent conversation', () => {
		const source = readFileSync(ADVANCED_PAGE, 'utf8');

		expect(source).toMatch(/import ToolLog from ['"]\$lib\/components\/chat\/ToolLog\.svelte['"]/);
		expect(source.match(/<ToolLog\b/g)).toHaveLength(1);
		expect(source).toMatch(/id="conversation-activity-rail"[\s\S]*?<ToolLog/);
		expect(source).toMatch(/OpenCode navigation is independent/);
	});

	test('keeps credentials out of the iframe and uses the direct transport', () => {
		const source = readFileSync(ADVANCED_PAGE, 'utf8');

		expect(source).toMatch(/if \(conn\.hasPassword\) return false/);
		expect(source).toMatch(/if \(url\.username \|\| url\.password\) return false/);
		expect(source).toMatch(/getTransport\(\)\.probeHealth\(\)/);
		expect(source).toMatch(/getTransport\(\)\.request\('GET'/);
		expect(source).toMatch(/<iframe[\s\S]*?src=\{frameUrl\}/);
	});

	test('loads an explicitly requested iframe session into parent Activity state', () => {
		const source = readFileSync(ADVANCED_PAGE, 'utf8');

		expect(source).toMatch(
			/await chat\.onEndpointChanged\(connectionId\)[\s\S]*?await chat\.openSession\(sessionId\)/,
		);
		expect(source).toMatch(/cross-origin[\s\S]*?internal iframe navigation/i);
	});

	test('provides one bottom-right page microphone outside the shared header', () => {
		const pageSource = readFileSync(ADVANCED_PAGE, 'utf8');
		const navbarSource = readFileSync(CHAT_NAVBAR, 'utf8');

		expect(pageSource.match(/<VoiceControl\b/g)).toHaveLength(1);
		expect(pageSource).toMatch(/<VoiceControl showSpeaker=\{false\}\s*\/>/);
		expect(pageSource).toMatch(
			/\.advanced-voice\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?right:[^;]+;[\s\S]*?bottom:/,
		);
		expect(navbarSource).not.toMatch(/<VoiceControl\b/);
	});
});
