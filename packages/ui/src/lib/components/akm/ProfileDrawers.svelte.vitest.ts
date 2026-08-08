import { describe, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import AgentProfileDrawer from './AgentProfileDrawer.svelte';
import ImproveProfileDrawer from './ImproveProfileDrawer.svelte';
import LlmProfileDrawer from './LlmProfileDrawer.svelte';
import { DEFAULT_ENABLED, PROCESS_KEYS, emptyFEntry } from './improve-process-helpers.js';
import type { AgentEngine, ImproveStrategy, LlmEngine } from './profile-types.js';

const llmDraft: LlmEngine = {
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
	supportsJsonSchema: false,
	enableThinking: false,
	extraParams: ''
};
const agentDraft: AgentEngine = {
	id: 'agent-1',
	name: 'default',
	platform: 'opencode',
	bin: '',
	args: '',
	workspace: '',
	model: '',
	timeoutMs: '',
	llmEngine: ''
};
const improveDraft: ImproveStrategy = {
	id: 'improve-1',
	name: 'default',
	description: '',
	limit: 25,
	processes: Object.fromEntries(
		PROCESS_KEYS.map((key) => [key, emptyFEntry(DEFAULT_ENABLED[key])])
	) as ImproveStrategy['processes'],
	syncEnabled: '',
	syncPush: '',
	syncMessage: ''
};

describe('AKM engine/strategy drawer accessibility', () => {
	test('LLM engine uses the shared focus-managed dialog', async () => {
		const oncancel = vi.fn();
		await render(LlmProfileDrawer, {
			props: { draft: llmDraft, oncancel, onapply: vi.fn() }
		});

		await expect.element(page.getByRole('dialog', { name: 'LLM engine' })).toBeVisible();
		await expect.element(page.getByRole('textbox', { name: 'Engine Name' })).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		expect(oncancel).toHaveBeenCalledOnce();
	});

	test('Agent engine restores focus when the shared drawer unmounts', async () => {
		const opener = document.createElement('button');
		document.body.append(opener);
		opener.focus();
		const oncancel = vi.fn();
		const { unmount } = await render(AgentProfileDrawer, {
			props: { draft: agentDraft, llmEngineNames: [], oncancel, onapply: vi.fn() }
		});

		await expect.element(page.getByRole('dialog', { name: 'Agent engine' })).toBeVisible();
		await expect.element(page.getByRole('textbox', { name: 'Engine Name' })).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		expect(oncancel).toHaveBeenCalledOnce();
		await unmount();
		expect(document.activeElement).toBe(opener);
		opener.remove();
	});

	test('Improve strategy uses the shared focus-managed dialog', async () => {
		const oncancel = vi.fn();
		await render(ImproveProfileDrawer, {
			props: { draft: improveDraft, engineNames: [], oncancel, onapply: vi.fn() }
		});

		await expect.element(page.getByRole('dialog', { name: 'Improve strategy' })).toBeVisible();
		await expect.element(page.getByRole('textbox', { name: 'Strategy Name' })).toHaveFocus();
		await userEvent.keyboard('{Escape}');
		expect(oncancel).toHaveBeenCalledOnce();
	});

	test('traps Tab inside an engine drawer', async () => {
		await render(AgentProfileDrawer, {
			props: { draft: agentDraft, llmEngineNames: [], oncancel: vi.fn(), onapply: vi.fn() }
		});
		const first = page.getByRole('textbox', { name: 'Engine Name' });
		const close = page.getByRole('button', { name: /^Close/ });

		await expect.element(first).toHaveFocus();
		await userEvent.keyboard('{Shift>}{Tab}{/Shift}');
		await expect.element(close).toHaveFocus();
	});
});
