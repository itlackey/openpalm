<script lang="ts">
	import SectionTabs, { type TabSection } from './SectionTabs.svelte';

	type SettingsTab = 'general' | 'connections';

	type Props = {
		activeTab: SettingsTab;
		onTabChange: (tab: SettingsTab) => void;
	};

	let { activeTab, onTabChange }: Props = $props();

	const SECTIONS: TabSection[] = [
		{
			id: 'settings',
			label: 'Settings',
			tabs: [
				{ id: 'general', label: 'General' },
				{ id: 'connections', label: 'Connections' },
			],
		},
	];
</script>

<SectionTabs
	active={activeTab}
	sections={SECTIONS}
	onSelect={(tab) => onTabChange(tab as SettingsTab)}
	ariaLabel="Settings sections"
	mobileLabel="Settings page"
	tabIdPrefix="settings-tab"
	panelIdPrefix="settings-panel"
	showSectionStrip={false}
/>
