<script lang="ts">
	import IconActivity from '$lib/components/icons/IconActivity.svelte';
	import IconAddons from '$lib/components/icons/IconAddons.svelte';
	import IconAgent from '$lib/components/icons/IconAgent.svelte';
	import IconAutomations from '$lib/components/icons/IconAutomations.svelte';
	import IconCloudDownload from '$lib/components/icons/IconCloudDownload.svelte';
	import IconHome from '$lib/components/icons/IconHome.svelte';
	import IconJournal from '$lib/components/icons/IconJournal.svelte';
	import IconLink from '$lib/components/icons/IconLink.svelte';
	import IconLock from '$lib/components/icons/IconLock.svelte';
	import IconMemory from '$lib/components/icons/IconMemory.svelte';
	import IconOverview from '$lib/components/icons/IconOverview.svelte';
	import IconServer from '$lib/components/icons/IconServer.svelte';
	import IconSharing from '$lib/components/icons/IconSharing.svelte';
	import SectionTabs, { type TabSection } from './SectionTabs.svelte';

	export type TabId =
		| 'overview'
		| 'addons'
		| 'automations'
		| 'connections'
		| 'secrets'
		| 'akm'
		| 'assistant'
		| 'host-sharing'
		| 'activity'
		| 'containers'
		| 'logs'
		| 'updates'
		| 'recovery';

	type Props = {
		active: TabId;
		onSelect: (tab: TabId) => void;
	};

	let { active, onSelect }: Props = $props();

	const SECTIONS: TabSection[] = [
		{
			id: 'health',
			label: 'Health',
			tabs: [
				{ id: 'overview', label: 'Overview', icon: IconOverview },
				{ id: 'activity', label: 'Activity', icon: IconActivity },
				{ id: 'containers', label: 'Systems', icon: IconServer },
				{ id: 'logs', label: 'Journal', icon: IconJournal },
				{ id: 'updates', label: 'Check-up', icon: IconCloudDownload },
				{ id: 'recovery', label: 'Recovery', icon: IconHome },
			],
		},
		{
			id: 'mind',
			label: 'Mind',
			tabs: [{ id: 'connections', label: 'AI Providers', icon: IconLink }],
		},
		{
			id: 'routines',
			label: 'Routines',
			tabs: [{ id: 'automations', label: 'Automations', icon: IconAutomations }],
		},
		{
			id: 'capabilities',
			label: 'Capabilities',
			tabs: [{ id: 'addons', label: 'Add-ons', icon: IconAddons }],
		},
		{
			id: 'knowledge',
			label: 'Knowledge',
			tabs: [
				{ id: 'akm', label: 'Memory', icon: IconMemory },
				{ id: 'assistant', label: 'Assistant', icon: IconAgent },
				{ id: 'secrets', label: 'Secrets', icon: IconLock },
				{ id: 'host-sharing', label: 'Sharing', icon: IconSharing },
			],
		},
	];
</script>

<SectionTabs
	{active}
	sections={SECTIONS}
	onSelect={(tab) => onSelect(tab as TabId)}
	ariaLabel="Admin sections"
	mobileLabel="Admin page"
/>
