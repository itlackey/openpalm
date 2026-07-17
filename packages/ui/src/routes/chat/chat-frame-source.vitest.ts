import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const CHAT_PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));
const CHAT_INPUT = fileURLToPath(
	new URL('../../lib/components/chat/ChatInput.svelte', import.meta.url)
);

describe('responsive chat frame source contract', () => {
	test('uses the shared chat navbar without page-owned navigation drawers', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');

		expect(source).toMatch(
			/import ChatNavbar from '\$lib\/components\/chrome\/ChatNavbar\.svelte'/
		);
		expect(source).toMatch(/<ChatNavbar bind:drawerOpen=\{navigationOpen\}\s*\/>/);
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
			's-dictate-btn'
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
			source.match(/aria-label=\{voiceActive \? 'Stop dictation' : 'Dictate'\}/g)
		).toHaveLength(1);
		expect(source).toMatch(/class="s-dictate-btn"/);
		expect(source).toMatch(/\.s-dictate-btn\s*\{[\s\S]*?right:[\s\S]*?bottom:/);
		expect(source).toMatch(/width:\s*44px;[\s\S]*?height:\s*44px/);
		expect(source).toMatch(/voiceState\.status === 'transcribing'/);
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

	test('accounts for the visible 52px in-flow navbar', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');

		expect(source).not.toMatch(/stillness-mode[\s\S]*?\.navbar/);
		expect(source).toMatch(/\.s-scroll\s*\{[\s\S]*?height:\s*calc\(100dvh - 52px\)/);
		expect(source).toMatch(/\.s-tool-rail\s*\{[\s\S]*?top:\s*52px/);
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
