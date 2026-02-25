import { describe, expect, it } from 'bun:test';

const wizardFile = new URL('./SetupWizard.svelte', import.meta.url).pathname;

describe('SetupWizard finish sequence', () => {
	it('starts channels only after setup.complete succeeds', async () => {
		const content = await Bun.file(wizardFile).text();
		const completeIndex = content.indexOf("type: 'setup.complete'");
		const startChannelsIndex = content.indexOf('Start enabled channels after setup.complete applies full compose');
		expect(completeIndex).toBeGreaterThan(-1);
		expect(startChannelsIndex).toBeGreaterThan(-1);
		expect(startChannelsIndex).toBeGreaterThan(completeIndex);
	});
});
