import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const CHAT_PAGE = fileURLToPath(new URL('./+page.svelte', import.meta.url));
const CHAT_ACTIVITY = fileURLToPath(
	new URL('../../../lib/components/chat/ChatActivity.svelte', import.meta.url)
);
const CHAT_INPUT = fileURLToPath(
	new URL('../../../lib/components/chat/ChatInput.svelte', import.meta.url)
);
const CHAT_FOOTER = fileURLToPath(
	new URL('../../../lib/components/chat/ChatFooter.svelte', import.meta.url)
);
const VOICE_CONTROL = fileURLToPath(
	new URL('../../../lib/components/chat/VoiceControl.svelte', import.meta.url)
);
const CONVERSATION_FRAME = fileURLToPath(
	new URL('../../../lib/components/chrome/ConversationFrame.svelte', import.meta.url)
);

describe('responsive chat frame source contract', () => {
	test('uses the shared conversation frame and enables conversation actions in the shared footer', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');
		const frameSource = readFileSync(CONVERSATION_FRAME, 'utf8');
		const footerSource = readFileSync(CHAT_FOOTER, 'utf8');
		const activitySource = readFileSync(CHAT_ACTIVITY, 'utf8');

		expect(source).toMatch(/<ConversationFrame bind:drawerOpen=\{navigationOpen\}>/);
		expect(frameSource).toMatch(/<ChatNavbar bind:drawerOpen \{showConversationControls\} \/>/);
		expect(source).toMatch(
			/<ChatFooter[\s\S]*?bind:draft[\s\S]*?bind:drawerOpen=\{navigationOpen\}[\s\S]*?showConversationActions[\s\S]*?dictationMode="draft"/
		);
		expect(footerSource).toMatch(
			/\{#if showConversationActions\}[\s\S]*?<NewChatButton \/>[\s\S]*?<ChatActivity[\s\S]*?bind:drawerOpen/
		);
		expect(activitySource).toMatch(
			/\.activity-trigger\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/
		);
		expect(activitySource).not.toContain('<span>Activity</span>');
		expect(footerSource).toMatch(/<footer class="chat-footer"/);
		expect(footerSource).not.toMatch(/\.chat-footer\s*\{[^}]*position:\s*fixed/);
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
		const footerSource = readFileSync(CHAT_FOOTER, 'utf8');

		expect(source).toMatch(/let navigationOpen = \$state\(false\)/);
		for (const className of ['s-tool-rail', 's-scroll']) {
			expect(source).toMatch(
				new RegExp(`class="${className}"[\\s\\S]*?inert=\\{navigationOpen\\}`)
			);
		}
		expect(footerSource).toMatch(/class="chat-footer-composer" inert=\{drawerOpen\}/);
		expect(footerSource).toMatch(/class="chat-footer-status" inert=\{drawerOpen\}/);
		expect(footerSource).toMatch(/class="chat-footer-notice" inert=\{drawerOpen\}/);
		expect(footerSource).toMatch(/<span inert=\{drawerOpen\}><NewChatButton \/><\/span>/);
		expect(footerSource).toMatch(/class="chat-footer-voice" inert=\{drawerOpen\}/);
		expect(source).not.toContain('ChatNavbar');
		expect(source).toMatch(
			/<ChatFooter[\s\S]*?\{#snippet notice\(\)\}[\s\S]*?class="s-error-banner"[\s\S]*?class="s-jump-latest"[\s\S]*?\{#snippet composer\(\)\}[\s\S]*?<ChatInput/
		);
	});

	test('keeps editable dictation at the bottom-right instead of auto-sending it', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');
		const footerSource = readFileSync(CHAT_FOOTER, 'utf8');
		const voiceSource = readFileSync(VOICE_CONTROL, 'utf8');

		expect(source).toMatch(/<ChatInput[\s\S]*?bind:draft/);
		expect(source).toMatch(/<ChatFooter[\s\S]*?bind:draft[\s\S]*?dictationMode="draft"/);
		expect(footerSource).toMatch(/<VoiceControl bind:draft \{dictationMode\} \/>/);
		expect(voiceSource).toMatch(/startListening\([\s\S]*?dictationMode === 'draft'[\s\S]*?draft =/);
		expect(
			voiceSource.match(
				/aria-label=\{!chatSurface[\s\S]*?'Stop dictation'[\s\S]*?'Dictate message'\}/g
			)
		).toHaveLength(1);
		expect(
			voiceSource.match(/title=\{!chatSurface[\s\S]*?'Stop dictation'[\s\S]*?'Dictate message'\}/g)
		).toHaveLength(1);
		expect(voiceSource).not.toMatch(/<span>Dictate<\/span>/);
		expect(voiceSource).toMatch(/class="voice-btn dictate-btn"/);
		expect(footerSource).toMatch(/\.chat-footer-actions\s*\{[\s\S]*?width:\s*100%/);
		expect(voiceSource).toMatch(/\.voice-btn\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px/);
		expect(voiceSource).toMatch(/voiceState\.status === 'transcribing'/);
	});

	test('keeps conversation and spoken-response toggles beside editable dictation', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');
		const footerSource = readFileSync(CHAT_FOOTER, 'utf8');
		const voiceSource = readFileSync(VOICE_CONTROL, 'utf8');

		expect(source).toMatch(/<ChatFooter[\s\S]*?dictationMode="draft"/);
		expect(footerSource).toMatch(/<VoiceControl bind:draft \{dictationMode\} \/>/);
		expect(voiceSource).toMatch(/role="toolbar" aria-label="Voice controls"/);
		expect(voiceSource).toMatch(
			/aria-label=\{voiceState\.conversationActive[\s\S]*?'Stop conversation mode'[\s\S]*?'Start conversation mode'\}/
		);
		expect(voiceSource).toContain("'Turn on spoken responses'");
		expect(voiceSource).toContain("'Turn off spoken responses'");
		// Conversation utterances go through sendUtterance (barge-in: stops the
		// in-flight turn first) — NOT chat.send()/handleSend(), which drops a
		// spoken utterance on the sending-guard while a reply is streaming.
		expect(voiceSource).toMatch(
			/startConversation\(\(transcript\) => \{[\s\S]*?chat\.sendUtterance\(transcript\)/
		);
		expect(voiceSource).toMatch(/setTtsAutoEnabled\(!voiceState\.ttsAutoEnabled\)/);
	});

	test('shares one compact composer and action row on wide screens', () => {
		const footerSource = readFileSync(CHAT_FOOTER, 'utf8');

		expect(footerSource).toMatch(
			/@media \(min-width: 1000px\)[\s\S]*?grid-template-areas:[\s\S]*?'conversation composer voice'/
		);
		expect(footerSource).toMatch(
			/grid-template-columns:\s*minmax\(0, 1fr\) minmax\(20rem, 34rem\) minmax\(0, 1fr\)/
		);
		expect(footerSource).toMatch(/\.has-composer \.chat-footer-actions\s*\{[\s\S]*?display:\s*contents/);
	});

	test('puts the narrow-screen message field and send action in one upper row', () => {
		const source = readFileSync(CHAT_INPUT, 'utf8');

		expect(source).toMatch(
			/@media \(max-width: 720px\)[\s\S]*?grid-template-areas:[\s\S]*?"field action"[\s\S]*?"rule rule"/
		);
		expect(source).toMatch(/\.composer-field\s*\{[\s\S]*?grid-area:\s*field/);
		expect(source).toMatch(/\.s-send-btn\s*\{[\s\S]*?grid-area:\s*action/);
	});

	test('keeps the wide composer within one standard control row', () => {
		const source = readFileSync(CHAT_INPUT, 'utf8');

		expect(source).toMatch(
			/@media \(min-width: 1000px\)[\s\S]*?grid-template-areas:[\s\S]*?"field action"[\s\S]*?"rule rule"/
		);
		expect(source).toMatch(
			/@media \(min-width: 1000px\)[\s\S]*?\.s-composer textarea\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?max-height:\s*44px;/
		);
	});

	test('keeps the desktop contextual activity rail box-safe at 1101px and above', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');

		expect(source).toMatch(/class="s-tool-rail"[\s\S]*?<ToolLog/);
		expect(source).toMatch(
			/\.s-tool-rail\s*\{[\s\S]*?box-sizing:\s*border-box;[\s\S]*?min-width:\s*0;/
		);
		expect(source).toMatch(
			/\.s-chat-content\s*\{[\s\S]*?position:\s*relative;[\s\S]*?flex:\s*1;/
		);
		expect(source).toMatch(/\.s-tool-rail\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*0/);
		expect(source).toMatch(/@media \(min-width: 1101px\)/);
		expect(source).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.s-tool-rail/);
		expect(source).not.toMatch(/@media \(min-width: (?:901|1024)px\)[\s\S]*?\.s-tool-rail/);
	});

	test('lets the shared frame own responsive viewport sizing', () => {
		const source = readFileSync(CHAT_PAGE, 'utf8');
		const frameSource = readFileSync(CONVERSATION_FRAME, 'utf8');

		expect(source).not.toMatch(/stillness-mode[\s\S]*?\.navbar/);
		expect(source).not.toMatch(/100dvh|s-chat-layout/);
		expect(frameSource).toMatch(/\.conversation-frame\s*\{[\s\S]*?height:\s*100%/);
		expect(source).toMatch(/\.s-scroll\s*\{[\s\S]*?flex:\s*1;[\s\S]*?min-height:\s*0/);
		expect(source).toMatch(/\.s-tool-rail\s*\{[\s\S]*?top:\s*0/);
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
