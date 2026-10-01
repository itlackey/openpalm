import { describe, expect, it } from 'bun:test';
import { remoteBrowserUrls, remoteTool, beginRemoteEnable } from './remote.js';
import { createOpenPalmState } from './foundation.js';

describe('native remote setup boundaries', () => {
	it('opens only complete vendor sign-in and pairing URLs, not arbitrary native output', () => {
		expect(remoteBrowserUrls('https://claude.com/cai/oauth/authorize?state=private\n')).toEqual([
			'https://claude.com/cai/oauth/authorize?state=private'
		]);
		expect(remoteBrowserUrls('Go https://auth.openai.com/codex/device\n')).toEqual([
			'https://auth.openai.com/codex/device'
		]);
		expect(
			remoteBrowserUrls('Go https://claude.ai/oauth/authorize?state=private&code=token\n')
		).toEqual(['https://claude.ai/oauth/authorize?state=private&code=token']);
		expect(remoteBrowserUrls('https://claude.ai/code/session-test\n')).toEqual([
			'https://claude.ai/code/session-test'
		]);
		for (const url of [
			'https://attacker.test/oauth/authorize',
			'https://claude.ai.attacker.test/code/foo',
			'https://user@claude.ai/code/foo',
			'https://claude.ai:8443/code/foo',
			'http://claude.ai/code/foo',
			'file:///tmp/foo',
			'https://claude.ai/settings'
		]) {
			expect(remoteBrowserUrls(`${url}\n`)).toEqual([]);
		}
		expect(remoteBrowserUrls('https://auth.openai.com/codex/device?state=incomplete')).toEqual([]);
		expect(remoteBrowserUrls('https://auth.openai.com/codex/device')).toEqual([]);
	});
	it('rejects untrusted enable and invalid tools before touching an installation', async () => {
		expect(() => remoteTool('claude; echo pwn')).toThrow();
		await expect(
			beginRemoteEnable(createOpenPalmState(), 'claude', { trusted: false })
		).rejects.toThrow('Confirm trusted');
		await expect(
			beginRemoteEnable(createOpenPalmState(), 'codex', {
				trusted: true,
				sandbox: 'danger-full-access' as never
			})
		).rejects.toThrow('sandboxing');
	});
});
