/**
 * Builders for the `ProviderActionResult` shape returned by every
 * `/admin/providers/<action>` route. Kept separate so tests can mock them
 * without pulling in the rest of the OpenCode helpers.
 */
import type { ProviderActionResult } from '$lib/types/providers.js';

export function actionSuccess(
	message: string,
	selectedProviderId: string,
	extra: Partial<ProviderActionResult> = {}
) {
	return {
		ok: true,
		message,
		selectedProviderId,
		...extra,
	} satisfies ProviderActionResult;
}

export function actionFailure(
	message: string,
	selectedProviderId?: string,
	extra: Partial<ProviderActionResult> = {}
) {
	return {
		ok: false,
		message,
		selectedProviderId,
		...extra,
	} satisfies ProviderActionResult;
}
