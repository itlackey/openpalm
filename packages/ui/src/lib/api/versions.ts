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
	configured: Record<VersionKey, string>;
	/** Images `openpalm update` leaves alone — read from OP_PINNED_IMAGES (#679). */
	pinned: VersionKey[];
};

export async function fetchVersions(): Promise<VersionsResponse> {
	const response = await requireOk(await request('GET', '/api/host/versions'));
	return (await response.json()) as VersionsResponse;
}

/** `pinned`, when given, is the COMPLETE pin list — omitting a key unpins it. */
export async function patchVersions(
	versions: Partial<Record<VersionKey, string>>,
	pinned?: VersionKey[]
): Promise<void> {
	await requireOk(
		await request('PATCH', '/api/host/versions', {
			...(Object.keys(versions).length > 0 ? { versions } : {}),
			...(pinned ? { pinned } : {})
		})
	);
}

/** A `rollback-` tag is never operator-typed (#639) — only restoreRunningImageIds writes that shape. */
export function isRollbackPin(value: string | undefined): boolean {
	return !!value?.startsWith('rollback-');
}
