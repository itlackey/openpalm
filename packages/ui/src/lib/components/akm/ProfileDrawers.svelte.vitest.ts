import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import AgentProfileDrawer from './AgentProfileDrawer.svelte';
import ImproveProfileDrawer from './ImproveProfileDrawer.svelte';
import LlmProfileDrawer from './LlmProfileDrawer.svelte';
import { DEFAULT_ENABLED, PROCESS_KEYS, emptyFEntry } from './improve-process-helpers.js';
import type { AgentProfile, ImproveProfile, LlmProfile } from './profile-types.js';

const llmDraft: LlmProfile = {
	id: 'llm-1',
	name: 'default',
	endpoint: '',
	model: '',
	provider: '',
	apiKey: '',
	showApiKey: false,
	temperature: '',
	maxTokens: '',
	timeoutMs: '',
	concurrency: '',
	contextLength: '',
	judgeModel: '',
	supportsJsonSchema: false,
	enableThinking: false,
	structuredOutput: false,
	extraParams: ''
};
const agentDraft: AgentProfile = {
	id: 'agent-1',
	name: 'default',
	platform: 'opencode',
	bin: '',
	args: '',
	workspace: '',
	model: ''
};
const improveDraft: ImproveProfile = {
	id: 'improve-1',
	name: 'default',
	description: '',
	limit: 25,
	autoAccept: 0,
	processes: Object.fromEntries(
		PROCESS_KEYS.map((key) => [key, emptyFEntry(DEFAULT_ENABLED[key])])
	) as ImproveProfile['processes'],
	syncEnabled: '',
	syncPush: '',
	syncMessage: ''
};

describe('AKM profile drawer accessibility', () => {
	test('LLM profile uses the shared focus-managed dialog', async () => {
		const oncancel = vi.fn();
		await render(LlmProfileDrawer, {
			props: { draft: llmDraft, oncancel, onapply: vi.fn() }
		});

		await expect.element(page.getByRole('dialog', { name: 'LLM profile' })).toBeVisible();
		await expect.element(page.getByRole('textbox', { name: 'Profile Name' })).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		expect(oncancel).toHaveBeenCalledOnce();
	});

	test('Agent profile restores focus when the shared drawer unmounts', async () => {
		const opener = document.createElement('button');
		document.body.append(opener);
		opener.focus();
		const oncancel = vi.fn();
		const { unmount } = await render(AgentProfileDrawer, {
			props: { draft: agentDraft, oncancel, onapply: vi.fn() }
		});

		await expect.element(page.getByRole('dialog', { name: 'Agent profile' })).toBeVisible();
		await expect.element(page.getByRole('textbox', { name: 'Profile Name' })).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		expect(oncancel).toHaveBeenCalledOnce();
		await unmount();
		expect(document.activeElement).toBe(opener);
		opener.remove();
	});

	test('Improve profile uses the shared focus-managed dialog', async () => {
		const oncancel = vi.fn();
		await render(ImproveProfileDrawer, {
			props: { draft: improveDraft, llmProfileNames: [], oncancel, onapply: vi.fn() }
		});

		await expect.element(page.getByRole('dialog', { name: 'Improve profile' })).toBeVisible();
		await expect.element(page.getByRole('textbox', { name: 'Profile Name' })).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		expect(oncancel).toHaveBeenCalledOnce();
	});

	test('traps Tab inside a profile drawer', async () => {
		await render(AgentProfileDrawer, {
			props: { draft: agentDraft, oncancel: vi.fn(), onapply: vi.fn() }
		});
		const first = page.getByRole('textbox', { name: 'Profile Name' });
		const close = page.getByRole('button', { name: /^Close/ });

		await expect.element(first).toHaveFocus();
		await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
		await expect.element(close).toHaveFocus();
	});
});
