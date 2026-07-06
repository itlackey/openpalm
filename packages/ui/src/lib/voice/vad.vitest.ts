import { describe, expect, test } from 'vitest';
import {
	advanceVad,
	computeRms,
	initialVadState,
	type VadConfig,
	type VadEvent,
	type VadTrackerState,
} from './vad.js';

// Round numbers so silence math is exact: 3 frames to start, 900ms / 50ms
// = 18 below-threshold frames to end.
const config: VadConfig = {
	threshold: 0.05,
	startFrames: 3,
	endSilenceMs: 900,
	frameIntervalMs: 50,
};

const LOUD = 0.2;
const QUIET = 0.01;

/** Feed a sequence of RMS levels, collecting emitted events per frame. */
function run(levels: number[], from?: VadTrackerState): { state: VadTrackerState; events: VadEvent[] } {
	let state = from ?? initialVadState();
	const events: VadEvent[] = [];
	for (const rms of levels) {
		const next = advanceVad(state, rms, config);
		state = next.state;
		events.push(next.event);
	}
	return { state, events };
}

describe('advanceVad — speech start hysteresis', () => {
	test('speech starts only after startFrames consecutive loud frames', () => {
		const { state, events } = run([LOUD, LOUD, LOUD]);
		expect(events).toEqual([null, null, 'speech-start']);
		expect(state.speaking).toBe(true);
	});

	test('fewer than startFrames loud frames never starts speech', () => {
		const { state, events } = run([LOUD, LOUD]);
		expect(events).toEqual([null, null]);
		expect(state.speaking).toBe(false);
	});

	test('a quiet frame resets the consecutive-loud counter', () => {
		const { state, events } = run([LOUD, LOUD, QUIET, LOUD, LOUD]);
		expect(events.every((e) => e === null)).toBe(true);
		expect(state.speaking).toBe(false);
		// Two loud frames after the reset — one more completes the run.
		const next = advanceVad(state, LOUD, config);
		expect(next.event).toBe('speech-start');
	});

	test('no start event while already speaking', () => {
		const started = run([LOUD, LOUD, LOUD]).state;
		const { events } = run([LOUD, LOUD, LOUD, LOUD], started);
		expect(events.every((e) => e === null)).toBe(true);
	});
});

describe('advanceVad — speech end hysteresis', () => {
	test('speech ends after endSilenceMs of quiet frames', () => {
		const started = run([LOUD, LOUD, LOUD]).state;
		const silentFrames = config.endSilenceMs / config.frameIntervalMs;
		const { state, events } = run(Array(silentFrames).fill(QUIET), started);
		expect(events.slice(0, -1).every((e) => e === null)).toBe(true);
		expect(events.at(-1)).toBe('speech-end');
		expect(state.speaking).toBe(false);
	});

	test('a brief quiet dip shorter than endSilenceMs does not end speech', () => {
		const started = run([LOUD, LOUD, LOUD]).state;
		// 17 quiet frames (850ms) then loud again — the silence clock resets.
		const dip = [...Array(17).fill(QUIET), LOUD, ...Array(17).fill(QUIET)];
		const { state, events } = run(dip, started);
		expect(events.every((e) => e === null)).toBe(true);
		expect(state.speaking).toBe(true);
	});

	test('after speech ends the start counter is fresh', () => {
		const started = run([LOUD, LOUD, LOUD]).state;
		const silentFrames = config.endSilenceMs / config.frameIntervalMs;
		const ended = run(Array(silentFrames).fill(QUIET), started).state;
		const { events } = run([LOUD, LOUD, LOUD], ended);
		expect(events).toEqual([null, null, 'speech-start']);
	});
});

describe('computeRms', () => {
	test('all-midpoint (silent) buffer has zero RMS', () => {
		expect(computeRms(new Uint8Array(64).fill(128))).toBe(0);
	});

	test('full-swing buffer approaches 1', () => {
		const samples = new Uint8Array(64);
		for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? 0 : 255;
		expect(computeRms(samples)).toBeGreaterThan(0.9);
	});

	test('louder buffers produce higher RMS', () => {
		const quiet = new Uint8Array(64).fill(132);
		const loud = new Uint8Array(64).fill(160);
		expect(computeRms(loud)).toBeGreaterThan(computeRms(quiet));
	});

	test('empty buffer is zero', () => {
		expect(computeRms(new Uint8Array(0))).toBe(0);
	});
});
