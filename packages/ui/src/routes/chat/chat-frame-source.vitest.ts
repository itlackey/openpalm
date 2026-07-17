import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const CHAT_PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));
const CHAT_ACTIVITY = fileURLToPath(
	new URL('../../lib/components/chat/ChatActivity.svelte', import.meta.url)
);
const CHAT_INPUT = fileURLToPath(
	new URL('../../lib/components/chat/ChatInput.svelte', import.meta.url)
);

describe('responsive chat frame source contract', () => {
	test('uses the shared chat navbar with a separate page-level Activity control', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');
		const activitySource = readFileSync(CHAT_ACTIVITY, 'utf8');

		expect(source).toMatch(
			/import ChatNavbar from '\$lib\/components\/chrome\/ChatNavbar\.svelte'/
		);
		expect(source).toMatch(/<ChatNavbar bind:drawerOpen=\{navigationOpen\}\s*\/>/);
		expect(source).toMatch(
			/class="s-bottom-left-controls"[\s\S]*?class="s-new-conversation" inert=\{navigationOpen\}[\s\S]*?<NewChatButton \/>[\s\S]*?<ChatActivity/
		);
		expect(source).toMatch(/<ChatActivity[\s\S]*?bind:drawerOpen=\{navigationOpen\}/);
		expect(activitySource).toMatch(
			/\.activity-trigger\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/
		);
		expect(activitySource).not.toContain('<span>Activity</span>');
		expect(source).toMatch(
			/\.s-bottom-left-controls\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?left:[\s\S]*?bottom:/
		);
		expect(activitySource).toMatch(/<Drawer[\s\S]*?side="left"/);
		for (const obsolete of [
			'ChatFrameHeader',
			'EndpointList',
			'SessionList',
			'ActivePanel',
			'activePanel',
			's-chat-side-panel',
			's-side-panel',
			's-panel-scrim',
			's-sheet-action'
		]) {
			expect(source).not.toContain(obsolete);
		}
	});

	test('makes every chat interaction layer inert while shared navigation is open', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');

		expect(source).toMatch(/let navigationOpen = \$state\(false\)/);
		for (const className of [
			's-tool-rail',
			's-scroll',
			's-error-banner',
			's-jump-latest',
			's-base',
			's-new-conversation',
			's-voice-controls'
		]) {
			expect(source).toMatch(
				new RegExp(`class="${className}"[\\s\\S]*?inert=\\{navigationOpen\\}`)
			);
		}
		expect(source).not.toMatch(/<ChatNavbar[^>]*inert=/);
	});

	test('keeps editable dictation at the bottom-right instead of auto-sending it', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');

		expect(source).toMatch(/startListening\(\(transcript\) => \{[\s\S]*?draft =/);
		expect(source).toMatch(/<ChatInput[\s\S]*?bind:draft/);
		expect(
			source.match(/aria-label=\{voiceActive \? 'Stop dictation' : 'Dictate message'\}/g)
		).toHaveLength(1);
		expect(
			source.match(/title=\{voiceActive \? 'Stop dictation' : 'Dictate message'\}/g)
		).toHaveLength(1);
		expect(source).not.toMatch(/<span>Dictate<\/span>/);
		expect(source).not.toContain('s-dictate-state');
		expect(source).toMatch(/class="[^"]*s-dictate-btn[^"]*"/);
		expect(source).toMatch(/\.s-voice-controls\s*\{[\s\S]*?right:[\s\S]*?bottom:/);
		expect(source).toMatch(/\.s-voice-btn\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
		expect(source).toMatch(/voiceState\.status === 'transcribing'/);
	});

	test('keeps conversation and spoken-response toggles beside editable dictation', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');

		expect(source).toMatch(/role="toolbar" aria-label="Voice controls"/);
		expect(source).toMatch(
			/aria-label=\{voiceState\.conversationActive[\s\S]*?'Stop conversation mode'[\s\S]*?'Start conversation mode'\}/
		);
		expect(source).toContain("'Turn on spoken responses'");
		expect(source).toContain("'Turn off spoken responses'");
		expect(source).toMatch(/startConversation\(\(transcript\) => void handleSend\(transcript\)\)/);
		expect(source).toMatch(/setTtsAutoEnabled\(!voiceState\.ttsAutoEnabled\)/);
	});

	test('keeps the desktop contextual activity rail box-safe at 1101px and above', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');

		expect(source).toMatch(/class="s-tool-rail"[\s\S]*?<ToolLog/);
		expect(source).toMatch(
			/\.s-tool-rail\s*\{[\s\S]*?box-sizing:\s*border-box;[\s\S]*?min-width:\s*0;/
		);
		expect(source).toMatch(/@media \(min-width: 1101px\)/);
		expect(source).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.s-tool-rail/);
		expect(source).not.toMatch(/@media \(min-width: (?:901|1024)px\)[\s\S]*?\.s-tool-rail/);
	});

	test('accounts for the responsive shared conversation navbar', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');

		expect(source).not.toMatch(/stillness-mode[\s\S]*?\.navbar/);
		expect(source).toMatch(/\.s-scroll\s*\{[\s\S]*?height:\s*calc\(100dvh - 64px\)/);
		expect(source).toMatch(/\.s-tool-rail\s*\{[\s\S]*?top:\s*64px/);
		expect(source).toMatch(/@media \(max-width: 999px\)[\s\S]*?calc\(100dvh - 112px\)/);
	});

	test('honors assistant selection before session selection and canonicalizes both', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');

		expect(source).toMatch(/buildChatPath\(sessionId, endpointsService\.activeId\)/);
		expect(source).toMatch(/page\.url\.searchParams\.get\('assistant'\)/);
		expect(source).toMatch(
			/await endpointsService\.load\(\);[\s\S]*?await endpointsService\.activate\(requestedAssistantId\)[\s\S]*?requestedSessionExists/
		);
		expect(source).toMatch(/syncSessionUrl/);
	});

	test('keeps dictation implementation out of the generic composer', () => {
		const source = readFileSync(CHAT_INPUT, 'utf8');
		expect(source).not.toMatch(/IconMic|startListening|conversation/i);
	});
});
