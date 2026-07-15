import type { VersionKey } from '@openpalm/lib';
import { request, requireOk } from './core.js';

export type { VersionKey } from '@openpalm/lib';

async function update(body: Record<string, string>): Promise<void> {
	await requireOk(await request('POST', '/api/host/update', body));
}

export function applyServiceUpdate(service: string): Promise<void> {
	return update({ service });
}

export function applyChanges(): Promise<void> {
	return update({});
}

export type UpdateChannel = 'latest' | 'next';

export type VersionsResponse = {
	configured: Record<VersionKey, string>;
	channel: UpdateChannel;
};

export async function fetchVersions(): Promise<VersionsResponse> {
	const response = await requireOk(await request('GET', '/api/host/versions'));
	return (await response.json()) as VersionsResponse;
}

export async function patchVersions(
	versions: Partial<Record<VersionKey, string>>,
	channel?: UpdateChannel
): Promise<void> {
	await requireOk(
		await request('PATCH', '/api/host/versions', {
			...(Object.keys(versions).length > 0 ? { versions } : {}),
			...(channel ? { channel } : {})
		})
	);
}

export type UiBuildUpdateResponse = {
	ok: boolean;
	updated: boolean;
	latestVersion: string | null;
	restarting: boolean;
	pendingRestart: boolean;
	redownloadRequired: boolean;
	requiredHarnessContract?: number;
};

export async function updateUiBuild(): Promise<UiBuildUpdateResponse> {
	const response = await requireOk(await request('POST', '/api/host/ui-version', {}));
	return (await response.json()) as UiBuildUpdateResponse;
}
