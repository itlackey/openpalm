import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const ADVANCED_PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));
const CHAT_NAVBAR = fileURLToPath(
	new URL('../../../lib/components/chrome/ChatNavbar.svelte', import.meta.url)
);
const CHAT_ACTIVITY = fileURLToPath(
	new URL('../../../lib/components/chat/ChatActivity.svelte', import.meta.url)
);
const CHAT_PAGE = fileURLToPath(new URL('../chat/+page.svelte', import.meta.url));
const CHAT_FOOTER = fileURLToPath(
	new URL('../../../lib/components/chat/ChatFooter.svelte', import.meta.url)
);
const VOICE_CONTROL = fileURLToPath(
	new URL('../../../lib/components/chat/VoiceControl.svelte', import.meta.url)
);
const CONVERSATION_FRAME = fileURLToPath(
	new URL('../../../lib/components/chrome/ConversationFrame.svelte', import.meta.url)
);

describe('Advanced fallback coherence', () => {
	test('uses the shared conversation frame and makes page content inert while its drawer is open', () => {
		const source = readFileSync(ADVANCED_PAGE, 'utf8');
		const frameSource = readFileSync(CONVERSATION_FRAME, 'utf8');

		expect(source).toMatch(
			/<ConversationFrame bind:drawerOpen=\{navigationOpen\} showConversationControls=\{false\}>/
		);
		expect(frameSource).toMatch(/<ChatNavbar bind:drawerOpen \{showConversationControls\} \/>/);
		expect(source).not.toMatch(/NewChatButton|advanced-new-conversation/);
		expect(source).toMatch(/<main class="advanced-layout" inert=\{navigationOpen\}>/);
		expect(source).not.toMatch(/100dvh|view-transition-name/);
		expect(frameSource).toMatch(/view-transition-name:\s*chat-content/);
	});

	test('keeps the bottom-left Activity drawer in conversation mode', () => {
		const navbarSource = readFileSync(CHAT_NAVBAR, 'utf8');
		const activitySource = readFileSync(CHAT_ACTIVITY, 'utf8');
		const chatSource = readFileSync(CHAT_PAGE, 'utf8');
		const footerSource = readFileSync(CHAT_FOOTER, 'utf8');

		expect(navbarSource).not.toMatch(/Activity/);
		expect(chatSource).toMatch(/<ChatFooter[\s\S]*?showConversationActions/);
		expect(footerSource).toMatch(
			/\{#if showConversationActions\}[\s\S]*?<NewChatButton \/>[\s\S]*?<ChatActivity/
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
			/endpointsService\.endpoints\.find\(\(connection\) => connection\.id === requestedAssistantId\)/
		);
		expect(source).toMatch(
			/await endpointsService\.activate\(requestedAssistant\.id\)[\s\S]*?await resolve\(/
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
			/await chat\.onEndpointChanged\(connectionId\)[\s\S]*?await chat\.openSession\(sessionId\)/
		);
	});

	test('keeps the shared three-button controls in a footer below advanced content', () => {
		const pageSource = readFileSync(ADVANCED_PAGE, 'utf8');
		const navbarSource = readFileSync(CHAT_NAVBAR, 'utf8');
		const footerSource = readFileSync(CHAT_FOOTER, 'utf8');
		const voiceSource = readFileSync(VOICE_CONTROL, 'utf8');

		expect(pageSource).toMatch(/<ChatFooter thinking=\{chat\.sending\} \/>/);
		expect(pageSource).not.toMatch(/showConversationActions|NewChatButton|ChatActivity/);
		expect(footerSource).toMatch(
			/<footer class="chat-footer"[\s\S]*?<VoiceStatusStrip \{thinking\} \/>[\s\S]*?<VoiceControl bind:draft \{dictationMode\} \/>[\s\S]*?<\/footer>/
		);
		expect(footerSource).toMatch(
			/\.chat-footer\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-shrink:\s*0;[\s\S]*?border-top:/
		);
		expect(footerSource).not.toMatch(/\.chat-footer\s*\{[^}]*position:\s*(?:fixed|absolute)/);
		expect(voiceSource.match(/<button\b/g)).toHaveLength(3);
		expect(voiceSource).toMatch(
			/\.voice-control\s*\{[\s\S]*?display:\s*flex;[\s\S]*?align-items:\s*center/
		);
		expect(navbarSource).not.toMatch(/<VoiceControl\b/);
	});
});
