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

export type VersionsResponse = {
	/** Rows present in state/stack.env — i.e. the pins. Absent key = not pinned. */
	pins: Partial<Record<VersionKey, string>>;
	/** Pin, or the release default the shipped compose file carries. */
	resolved: Record<VersionKey, string>;
	/** Image refs actually running, keyed by compose service. null = docker unreachable. */
	running: Record<string, string> | null;
};

export async function fetchVersions(): Promise<VersionsResponse> {
	const response = await requireOk(await request('GET', '/api/host/versions'));
	return (await response.json()) as VersionsResponse;
}

/** An EMPTY tag clears that image's pin, so it follows releases again (#679). */
export async function patchVersions(versions: Partial<Record<VersionKey, string>>): Promise<void> {
	await requireOk(
		await request('PATCH', '/api/host/versions', {
			...(Object.keys(versions).length > 0 ? { versions } : {})
		})
	);
}


