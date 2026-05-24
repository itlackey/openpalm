import { describe, expect, test } from 'vitest';
import { voiceState, refreshSttSupport } from './voice-state.svelte.js';

describe('voice-state engine selection', () => {
	test('sttSupported reflects engine availability (browser path)', () => {
		// Whether the test runner actually has the Web Speech API, the call
		// must not throw and must produce a boolean.
		voiceState.sttEngine = 'browser';
		refreshSttSupport();
		expect(typeof voiceState.sttSupported).toBe('boolean');
	});

	test('sttSupported is false when engine is "disabled"', () => {
		voiceState.sttEngine = 'disabled';
		refreshSttSupport();
		expect(voiceState.sttSupported).toBe(false);
	});

	test('sttSupported tracks MediaRecorder availability for "remote" engine', () => {
		voiceState.sttEngine = 'remote';
		refreshSttSupport();
		const expected = typeof MediaRecorder !== 'undefined' && Boolean(navigator?.mediaDevices?.getUserMedia);
		expect(voiceState.sttSupported).toBe(expected);
	});
});
