import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	acquireStackLock,
	releaseStackLock,
	type ImportEntry,
	type ImportPlan
} from '@openpalm/lib';

import { main } from '../main.js';
import { bootstrapInstall } from './install.js';
import { printImportPlan } from './import.js';

const log = spyOn(console, 'log').mockImplementation(() => {});
const warn = spyOn(console, 'warn').mockImplementation(() => {});

afterAll(() => {
	log.mockRestore();
	warn.mockRestore();
});

afterEach(() => {
	log.mockClear();
	warn.mockClear();
});

function entry(index: number, override: Partial<ImportEntry> = {}): ImportEntry {
	return {
		source: `/old/workspace/file-${index}`,
		destination: `/fresh/workspace/file-${index}`,
		relativeSource: `workspace/file-${index}`,
		relativeDestination: `workspace/file-${index}`,
		category: 'workspace',
		action: 'copy',
		bytes: 1,
		sha256: 'a'.repeat(64),
		...override
	};
}

function plan(override: Partial<ImportPlan> = {}): ImportPlan {
	return {
		version: 1,
		sourceHome: '/old',
		destinationHome: '/fresh',
		entries: [],
		warnings: [],
		preservation: [],
		reviewRequired: false,
		totalBytes: 0,
		conflicts: 0,
		copyCount: 0,
		digest: 'b'.repeat(64),
		...override
	};
}

function output(): string {
	return [...log.mock.calls, ...warn.mock.calls].map((args) => args.join(' ')).join('\n');
}

describe('import plan output', () => {
	it('never buries missing native history behind bounded filesystem warnings', () => {
		printImportPlan(
			plan({
				reviewRequired: true,
				preservation: [
					{
						category: 'Native history',
						disposition: 'review-required',
						paths: ['data'],
						note: 'Recover conversations separately.'
					}
				],
				warnings: Array.from({ length: 50 }, (_, i) => `Other warning ${i}`)
			}),
			false
		);
		expect(output()).toContain('NOT a full migration');
		expect(output()).toContain('review-required: Native history');
		expect(output()).toContain('--acknowledge-unrestored');
	});
	it('summarizes large homes without flooding the terminal and retains actionable warnings', () => {
		const entries = Array.from({ length: 93_056 }, (_, index) => entry(index));
		entries.push(entry(93_057, { category: 'task', action: 'stage-task' }));
		const warnings = Array.from(
			{ length: 4_356 },
			(_, index) => `Skipped symlink: /old/workspace/link-${index}`
		);
		warnings.push(
			'Skipped provider authentication: rerun with --include-provider-auth to copy approved provider keys.'
		);
		warnings.push(
			'Skipped historical AKM configuration (config/akm): it may contain credentials; recreate supported settings. Source preserved.'
		);
		printImportPlan(
			plan({ entries, warnings, copyCount: entries.length, totalBytes: entries.length }),
			false
		);
		expect(log.mock.calls.length + warn.mock.calls.length).toBeLessThan(25);
		expect(output()).toContain('workspace: 93056 copy');
		expect(output()).toContain('task: 1 stage-task');
		expect(output()).toContain('warning (4356): Skipped symlink');
		expect(output()).toContain('--include-provider-auth');
		expect(output()).toContain('it may contain credentials');
		expect(output()).toContain('not scheduled');
		expect(output()).toContain('openpalm task adopt <file>');
		expect(output()).toContain('--dry-run --json');
		expect(output()).not.toContain('link-4355');
	});

	it('highlights bounded conflict paths and reports every action by category', () => {
		const entries = Array.from({ length: 30 }, (_, index) => entry(index, { action: 'conflict' }));
		entries.push(entry(31, { category: 'secret', action: 'replace-pristine' }));
		entries.push(entry(32, { category: 'knowledge', action: 'skip-identical' }));
		printImportPlan(plan({ entries, conflicts: 30, copyCount: 1 }), false);
		expect(output()).toContain('workspace: 30 conflict');
		expect(output()).toContain('secret: 1 replace-pristine');
		expect(output()).toContain('knowledge: 1 skip-identical');
		expect(output()).toContain('conflict: workspace/file-0 -> workspace/file-0');
		expect(output()).not.toContain('conflict: workspace/file-10');
		expect(output()).toContain('20 more conflict(s)');
	});

	it('bounds varied warnings while prioritizing provider guidance', () => {
		const warnings = Array.from(
			{ length: 30 },
			(_, index) => `Unusual filesystem warning ${index}`
		);
		warnings.push('Skipped provider secret: configure a new provider credential before setup.');
		printImportPlan(plan({ warnings }), false);
		expect(output()).toContain('31 warning(s) in 31 group(s)');
		expect(output()).toContain('configure a new provider credential');
		expect(output()).toContain('23 more warning group(s)');
		expect(log.mock.calls.length + warn.mock.calls.length).toBeLessThan(25);
	});

	it('keeps complete machine-readable JSON without human summaries or warnings', () => {
		const value = plan({ entries: [entry(0)], warnings: ['A warning'] });
		printImportPlan(value, true);
		expect(log.mock.calls).toHaveLength(1);
		expect(warn.mock.calls).toHaveLength(0);
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(value);
	});

	it('makes untrusted paths and warnings single-line terminal text', () => {
		printImportPlan(
			plan({
				sourceHome: '/old\n\u001b[31m',
				entries: [entry(0, { action: 'conflict', relativeSource: 'workspace/\n\u001b[31m' })],
				warnings: [`Skipped symlink: ${'x'.repeat(2_000)}\n\u001b[31m`],
				conflicts: 1
			}),
			false
		);
		for (const args of [...log.mock.calls, ...warn.mock.calls]) {
			expect(
				[...String(args[0])].some(
					(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
				)
			).toBe(false);
			expect(String(args[0]).length).toBeLessThan(600);
		}
	});
});

describe('import command safety', () => {
	it('keeps previews read-only and failed apply atomic for destination conflicts without exposing secrets', async () => {
		const root = mkdtempSync(join(tmpdir(), 'openpalm-import-cli-test-'));
		const originalHome = process.env.OP_HOME;
		const originalRepo = process.env.OPENPALM_REPO_ROOT;
		try {
			const source = join(root, 'source');
			const home = join(root, 'fresh');
			process.env.OP_HOME = home;
			process.env.OPENPALM_REPO_ROOT = join(import.meta.dir, '../../../..');
			await bootstrapInstall({ start: false });
			mkdirSync(join(source, 'knowledge', 'secrets'), { recursive: true });
			writeFileSync(join(source, 'knowledge', 'first.md'), 'source knowledge');
			writeFileSync(join(source, 'knowledge', 'conflict.md'), 'source conflict');
			const secret = JSON.stringify({
				example: { type: 'api', key: 'private-provider-test-value' }
			});
			writeFileSync(join(source, 'knowledge', 'secrets', 'auth.json'), secret);
			writeFileSync(join(home, 'knowledge', 'conflict.md'), 'operator destination');
			log.mockClear();
			await main(['import', '--from', source, '--dry-run']);
			expect(existsSync(join(home, 'knowledge', 'first.md'))).toBe(false);
			expect(output()).toContain('conflict: knowledge/conflict.md');
			await expect(main(['import', '--from', source, '--apply'])).rejects.toThrow(
				'destination conflict'
			);
			expect(existsSync(join(home, 'knowledge', 'first.md'))).toBe(false);
			expect(readFileSync(join(home, 'knowledge', 'conflict.md'), 'utf8')).toBe(
				'operator destination'
			);
			expect(readFileSync(join(source, 'knowledge', 'first.md'), 'utf8')).toBe('source knowledge');
			expect(readFileSync(join(source, 'knowledge', 'secrets', 'auth.json'), 'utf8')).toBe(secret);
			expect(output()).not.toContain('private-provider-test-value');
			const lock = acquireStackLock(join(home, 'data'));
			expect(lock).not.toBeNull();
			releaseStackLock(lock);
		} finally {
			if (originalHome === undefined) delete process.env.OP_HOME;
			else process.env.OP_HOME = originalHome;
			if (originalRepo === undefined) delete process.env.OPENPALM_REPO_ROOT;
			else process.env.OPENPALM_REPO_ROOT = originalRepo;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
