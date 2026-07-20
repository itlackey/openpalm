import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

function source(file: string): string {
	return readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
}

const akmTab = source('./AkmTab.svelte');
const embeddingSection = source('./EmbeddingSection.svelte');
const behaviorSection = source('./BehaviorSection.svelte');
const improveProfilesSection = source('./ImproveProfilesSection.svelte');
const profileRow = source('./ProfileRow.svelte');
const profileSections = [
	source('./AgentProfilesSection.svelte'),
	source('./ImproveProfilesSection.svelte'),
	source('./LlmProfilesSection.svelte'),
];

describe('AKM admin presentation', () => {
	test('keeps panel and profile containers inside narrow viewports', () => {
		expect(akmTab).toMatch(/\.panel[\s\S]*?min-width:\s*0[\s\S]*?box-sizing:\s*border-box/);
		expect(akmTab).toMatch(/\.panel-body[\s\S]*?min-width:\s*0[\s\S]*?box-sizing:\s*border-box/);
		for (const section of profileSections) {
			expect(section).toMatch(/\.config-section[\s\S]*?min-width:\s*0/);
			expect(section).toMatch(/\.profile-list[\s\S]*?min-width:\s*0/);
		}
	});

	test('allows grid columns and long profile text to shrink or wrap', () => {
		for (const section of [embeddingSection, behaviorSection]) {
			expect(section).toMatch(/minmax\(min\(100%,\s*220px\),\s*1fr\)/);
			expect(section).not.toMatch(/minmax\(220px,\s*1fr\)/);
		}
		expect(profileRow).toMatch(/\.profile-row-name[\s\S]*?white-space:\s*normal/);
		expect(profileRow).toMatch(/\.profile-row-name[\s\S]*?overflow-wrap:\s*anywhere/);
		expect(profileRow).toMatch(/\.profile-row-actions[\s\S]*?flex-wrap:\s*wrap/);
		expect(improveProfilesSection).toMatch(/\.profile-row-desc[\s\S]*?white-space:\s*normal/);
		expect(improveProfilesSection).toMatch(/\.profile-row-desc[\s\S]*?overflow-wrap:\s*anywhere/);
	});

	test('caps the lead note at a readable measure', () => {
		expect(akmTab).toMatch(/\.section-note--lead[\s\S]*?max-width:\s*(?:[1-7]?\d|8[0-5])ch/);
	});

	test('gives destructive profile actions an AA error treatment and 44px target', () => {
		expect(profileRow).toMatch(/\.profile-row-actions[\s\S]*?min-height:\s*2\.75rem/);
		expect(profileRow).toMatch(/\.btn-danger[\s\S]*?color:\s*var\(--s-error\)/);
		expect(profileRow).toMatch(/\.btn-danger[\s\S]*?border-color:\s*var\(--s-error\)/);
		expect(profileRow).toMatch(/\.btn-danger[\s\S]*?opacity:\s*1/);
	});
});
