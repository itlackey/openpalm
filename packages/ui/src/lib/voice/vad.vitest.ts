import { describe, expect, test } from 'vitest';
import {
	advanceVad,
	calibrateThreshold,
	computeRms,
	deriveStrictVadConfig,
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
function run(
	levels: number[],
	from?: VadTrackerState,
	cfg: VadConfig = config
): { state: VadTrackerState; events: VadEvent[] } {
	let state = from ?? initialVadState();
	const events: VadEvent[] = [];
	for (const rms of levels) {
		const next = advanceVad(state, rms, cfg);
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

describe('deriveStrictVadConfig', () => {
	test('triples the threshold and requires ~400ms sustained speech; silence window unchanged', () => {
		const strict = deriveStrictVadConfig(config);
		expect(strict.threshold).toBeCloseTo(config.threshold * 3);
		expect(strict.startFrames).toBe(8);
		expect(strict.endSilenceMs).toBe(config.endSilenceMs);
		expect(strict.frameIntervalMs).toBe(config.frameIntervalMs);
	});

	test('an RMS run that trips the normal config does not trip the strict config', () => {
		// 3 frames of 0.1: above the normal 0.05 threshold for startFrames.
		const levels = [0.1, 0.1, 0.1];
		expect(run(levels).events).toEqual([null, null, 'speech-start']);

		// Same run under strict: 0.1 < 0.15 and only 3 frames — never starts.
		const strict = deriveStrictVadConfig(config);
		const { state, events } = run(levels, undefined, strict);
		expect(events.every((e) => e === null)).toBe(true);
		expect(state.speaking).toBe(false);
	});

	test('sustained genuinely-loud speech still starts under the strict config', () => {
		const strict = deriveStrictVadConfig(config);
		const { events } = run(Array(8).fill(0.2), undefined, strict);
		expect(events.at(-1)).toBe('speech-start');
		expect(events.slice(0, -1).every((e) => e === null)).toBe(true);
	});
});

describe('calibrateThreshold', () => {
	test('a quiet room never lowers the gate below the base threshold', () => {
		expect(calibrateThreshold(Array(20).fill(0.004), 0.02)).toBe(0.02);
	});

	test('a noisy room raises the threshold above the ambient floor', () => {
		expect(calibrateThreshold(Array(20).fill(0.04), 0.02)).toBeCloseTo(0.04 * 2.75);
	});

	test('speech during the calibration window cannot inflate the floor', () => {
		// The 20th percentile sits in the quiet majority — the loud tail
		// (someone talking over calibration) is ignored.
		const samples = [...Array(14).fill(0.004), ...Array(6).fill(0.5)];
		expect(calibrateThreshold(samples, 0.02)).toBe(0.02);
	});

	test('no samples falls back to the base threshold', () => {
		expect(calibrateThreshold([], 0.02)).toBe(0.02);
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
