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
};

export async function fetchVersions(): Promise<VersionsResponse> {
	const response = await requireOk(await request('GET', '/api/host/versions'));
	return (await response.json()) as VersionsResponse;
}

export async function patchVersions(versions: Partial<Record<VersionKey, string>>): Promise<void> {
	await requireOk(
		await request('PATCH', '/api/host/versions', {
			...(Object.keys(versions).length > 0 ? { versions } : {})
		})
	);
}

/** A `rollback-` tag is never an operator-typed pin (#639) — only restoreRunningImageIds writes that shape. */
export function isRollbackPin(value: string | undefined): boolean {
	return !!value?.startsWith('rollback-');
}

export type ClearRollbackPinResponse = {
	cleared: Partial<Record<VersionKey, { from: string; to: string }>>;
};

/** Clears only `rollback-` pinned keys via the shared lib function — never a deliberate operator pin. */
export async function clearRollbackPin(): Promise<ClearRollbackPinResponse> {
	const response = await requireOk(await request('POST', '/api/host/versions/clear-rollback-pin'));
	return (await response.json()) as ClearRollbackPinResponse;
}
