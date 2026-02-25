import { describe, expect, it } from 'bun:test';

const wizardFile = new URL('./SetupWizard.svelte', import.meta.url).pathname;

describe('SetupWizard finish sequence', () => {
	it('does not invoke setup.start_core during finish flow', async () => {
		const content = await Bun.file(wizardFile).text();
		const startCoreIndex = content.indexOf("type: 'setup.start_core'");
		expect(startCoreIndex).toBe(-1);
	});

	it('keeps startup sequencing tied to setup.complete finalization', async () => {
		const content = await Bun.file(wizardFile).text();
		const channelsSaveIndex = content.indexOf("type: 'setup.channels'");
		const stepSaveIndex = content.indexOf("type: 'setup.step'", channelsSaveIndex);
		const completeIndex = content.indexOf("type: 'setup.complete'", stepSaveIndex);
		const completeGuardIndex = content.indexOf('if (!completeResult.ok)');
		const startChannelsCommentIndex = content.indexOf(
			'Start enabled channels after setup.complete applies full compose'
		);
		const serviceUpIndex = content.indexOf("type: 'service.up'");

		expect(channelsSaveIndex).toBeGreaterThan(-1);
		expect(stepSaveIndex).toBeGreaterThan(channelsSaveIndex);
		expect(completeIndex).toBeGreaterThan(stepSaveIndex);
		expect(completeGuardIndex).toBeGreaterThan(completeIndex);
		expect(startChannelsCommentIndex).toBeGreaterThan(completeGuardIndex);
		expect(serviceUpIndex).toBeGreaterThan(startChannelsCommentIndex);
	});
});
