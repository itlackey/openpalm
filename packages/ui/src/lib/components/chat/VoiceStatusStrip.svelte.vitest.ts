/**
 * VoiceStatusStrip component tests.
 *
 * This strip is the only place interim-transcript feedback and the
 * autoplay-resume banner are visible on /chat — VoiceControl (which also
 * renders them) lives in the Navbar, and the chat page hides the navbar.
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
		await expect.element(page.getByText('transcribing…')).not.toBeInTheDocument();
	});
});

describe('VoiceStatusStrip — transcribing', () => {
	test('shows a transcribing indicator', async () => {
		voiceState.status = 'transcribing';
		render(VoiceStatusStrip);
		await expect.element(page.getByText('transcribing…')).toBeVisible();
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
});
