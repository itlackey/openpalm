/**
 * VoiceStatusStrip component tests.
 *
 * This strip keeps interim-transcript feedback and autoplay recovery separate
 * from the compact three-button VoiceControl toolbar.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import VoiceStatusStrip from './VoiceStatusStrip.svelte';
import { voiceState } from '$lib/voice/voice-state.svelte.js';

afterEach(() => {
	voiceState.status = 'idle';
	voiceState.interimTranscript = '';
	voiceState.autoplayBlocked = false;
	voiceState.conversationActive = false;
});

describe('VoiceStatusStrip — idle', () => {
	test('renders nothing visible when idle', async () => {
		render(VoiceStatusStrip);
		await expect.element(page.getByText('transcribing…')).not.toBeInTheDocument();
		await expect.element(page.getByRole('button', { name: 'Resume paused audio' })).not.toBeInTheDocument();
	});
});

describe('VoiceStatusStrip — interim transcript', () => {
	test('shows the live interim transcript while recording', async () => {
		voiceState.status = 'recording';
		voiceState.interimTranscript = 'hello there';
		render(VoiceStatusStrip);
		await expect.element(page.getByText('hello there', { exact: true })).toBeVisible();
	});

	test('does not show interim text when recording with an empty transcript', async () => {
		voiceState.status = 'recording';
		voiceState.interimTranscript = '';
		render(VoiceStatusStrip);
		await expect.element(page.getByText('listening…')).toBeVisible();
	});
});

describe('VoiceStatusStrip — transcribing', () => {
	test('shows a transcribing indicator', async () => {
		voiceState.status = 'transcribing';
		render(VoiceStatusStrip);
		await expect.element(page.getByText('transcribing…')).toBeVisible();
	});
});

describe('VoiceStatusStrip — conversation mode', () => {
	test('shows listening status without duplicating the footer conversation control', async () => {
		voiceState.conversationActive = true;
		voiceState.status = 'recording';
		render(VoiceStatusStrip);
		await expect.element(page.getByText('listening…', { exact: true })).toBeVisible();
		await expect.element(page.getByRole('button', { name: 'End conversation mode' })).not.toBeInTheDocument();
	});

	test('shows speaking… while TTS is playing', async () => {
		voiceState.conversationActive = true;
		voiceState.status = 'speaking';
		render(VoiceStatusStrip);
		await expect.element(page.getByText('speaking…', { exact: true })).toBeVisible();
	});

	test('shows thinking… while the assistant is composing a reply', async () => {
		voiceState.conversationActive = true;
		voiceState.status = 'recording';
		render(VoiceStatusStrip, { thinking: true });
		await expect.element(page.getByText('thinking…', { exact: true })).toBeVisible();
	});

	test('shows transcribing… rather than thinking… while audio is being transcribed', async () => {
		voiceState.conversationActive = true;
		voiceState.status = 'transcribing';
		render(VoiceStatusStrip, { thinking: true });
		await expect.element(page.getByText('transcribing…', { exact: true })).toBeVisible();
		await expect.element(page.getByText('thinking…', { exact: true })).not.toBeInTheDocument();
	});

	test('shows preparing… while speech is being synthesized', async () => {
		voiceState.conversationActive = true;
		voiceState.status = 'preparing';
		render(VoiceStatusStrip, { thinking: true });
		await expect.element(page.getByText('preparing…', { exact: true })).toBeVisible();
		await expect.element(page.getByText('thinking…', { exact: true })).not.toBeInTheDocument();
	});

	test('prefers the live interim transcript over the state label', async () => {
		voiceState.conversationActive = true;
		voiceState.status = 'recording';
		voiceState.interimTranscript = 'so about that';
		render(VoiceStatusStrip);
		await expect.element(page.getByText('so about that', { exact: true })).toBeVisible();
	});

});

describe('VoiceStatusStrip — autoplay recovery', () => {
	test('shows the resume button when autoplay is blocked', async () => {
		voiceState.autoplayBlocked = true;
		render(VoiceStatusStrip);
		await expect.element(page.getByRole('button', { name: 'Resume paused audio' })).toBeVisible();
	});

	test('clicking the resume button clears autoplayBlocked and hides the banner', async () => {
		voiceState.autoplayBlocked = true;
		render(VoiceStatusStrip);
		await page.getByRole('button', { name: 'Resume paused audio' }).click();
		expect(voiceState.autoplayBlocked).toBe(false);
		await expect.element(page.getByRole('button', { name: 'Resume paused audio' })).not.toBeInTheDocument();
	});

	// Conversation mode must never shadow the resume affordance: this strip
	// is the only resume surface on /chat, and a blocked first utterance
	// stalls every queued reply until resumed.
	test('shows the resume button alongside the conversation state while hands-free', async () => {
		voiceState.conversationActive = true;
		voiceState.status = 'recording';
		voiceState.autoplayBlocked = true;
		render(VoiceStatusStrip);
		await expect.element(page.getByText('listening…', { exact: true })).toBeVisible();
		await expect.element(page.getByRole('button', { name: 'Resume paused audio' })).toBeVisible();
	});

	test('clicking resume during conversation mode clears the block and keeps the conversation armed', async () => {
		voiceState.conversationActive = true;
		voiceState.status = 'recording';
		voiceState.autoplayBlocked = true;
		render(VoiceStatusStrip);
		await page.getByRole('button', { name: 'Resume paused audio' }).click();
		expect(voiceState.autoplayBlocked).toBe(false);
		expect(voiceState.conversationActive).toBe(true);
		await expect.element(page.getByRole('button', { name: 'Resume paused audio' })).not.toBeInTheDocument();
		await expect.element(page.getByText('listening…', { exact: true })).toBeVisible();
	});
});
