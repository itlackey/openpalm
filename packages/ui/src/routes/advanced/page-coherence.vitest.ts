import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ADVANCED_PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));
const CHAT_NAVBAR = fileURLToPath(
	new URL('../../lib/components/chrome/ChatNavbar.svelte', import.meta.url),
);
const CHAT_ACTIVITY = fileURLToPath(
	new URL('../../lib/components/chat/ChatActivity.svelte', import.meta.url),
);
const CHAT_PAGE = fileURLToPath(new URL('../chat/+page.svelte', import.meta.url));

describe('Advanced fallback coherence', () => {
	test('uses the application header and makes the page inert while its drawer is open', () => {
		const source = readFileSync(ADVANCED_PAGE, 'utf8');

		expect(source).toMatch(/<ChatNavbar bind:drawerOpen=\{navigationOpen\}\s*\/>/);
		expect(source).toMatch(/class="advanced-new-conversation"[\s\S]*?<NewChatButton \/>/);
		expect(source).toMatch(/<div class="advanced-layout" inert=\{navigationOpen\}>/);
		expect(source).toMatch(/height:\s*calc\(100dvh - 64px\)/);
		expect(source).toMatch(/height:\s*calc\(100dvh - 112px\)/);
	});

	test('keeps the bottom-left Activity drawer in conversation mode', () => {
		const navbarSource = readFileSync(CHAT_NAVBAR, 'utf8');
		const activitySource = readFileSync(CHAT_ACTIVITY, 'utf8');
		const chatSource = readFileSync(CHAT_PAGE, 'utf8');

		expect(navbarSource).not.toMatch(/Activity/);
		expect(chatSource).toMatch(
			/class="s-bottom-left-controls"[\s\S]*?class="s-new-conversation" inert=\{navigationOpen\}[\s\S]*?<NewChatButton \/>[\s\S]*?<ChatActivity/
		);
		expect(activitySource).toMatch(/<Drawer[\s\S]*?title="Activity"/);
		expect(activitySource).toMatch(
			/\.activity-trigger\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/
		);
		expect(activitySource).not.toMatch(/\.activity-trigger\s*\{[^}]*display:\s*none/i);
		expect(activitySource).not.toMatch(/openCode|OpenCode/);
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

	test('renders OpenCode directly without Activity UI or reserved layout', () => {
		const source = readFileSync(ADVANCED_PAGE, 'utf8');

		expect(source).toMatch(/\{#if mode === 'iframe'\}\s*<div class="opencode-shell">/);
		expect(source).not.toMatch(/ChatActivity|ToolLog|activityRailOpen/);
		expect(source).not.toMatch(/opencode-context|conversation-activity|advanced-activity/);
		expect(source).not.toMatch(/\bActivity\b/);
	});

	test('keeps credentials out of the iframe and uses the direct transport', () => {
		const source = readFileSync(ADVANCED_PAGE, 'utf8');

		expect(source).toMatch(/if \(conn\.hasPassword\) return false/);
		expect(source).toMatch(/if \(url\.username \|\| url\.password\) return false/);
		expect(source).toMatch(/getTransport\(\)\.probeHealth\(\)/);
		expect(source).toMatch(/getTransport\(\)\.request\(\s*'GET'/);
		expect(source).toMatch(/<iframe[\s\S]*?src=\{frameUrl\}/);
	});

	test('loads an explicitly requested iframe session into shared conversation state', () => {
		const source = readFileSync(ADVANCED_PAGE, 'utf8');

		expect(source).toMatch(
			/await chat\.onEndpointChanged\(connectionId\)[\s\S]*?await chat\.openSession\(sessionId\)/,
		);
	});

	test('provides one bottom-right page microphone outside the shared header', () => {
		const pageSource = readFileSync(ADVANCED_PAGE, 'utf8');
		const navbarSource = readFileSync(CHAT_NAVBAR, 'utf8');

		expect(pageSource.match(/<VoiceControl\b/g)).toHaveLength(1);
		expect(pageSource).toMatch(/<VoiceControl showSpeaker=\{false\}\s*\/>/);
		expect(pageSource).toMatch(
			/\.advanced-voice\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?right:[^;]+;[\s\S]*?bottom:/,
		);
		expect(pageSource).not.toContain('Speak &amp; send');
		expect(navbarSource).not.toMatch(/<VoiceControl\b/);
	});
});
