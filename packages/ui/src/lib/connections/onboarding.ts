import {
	type CandidateVerificationResult,
	type ResolvedAuth,
	verifyDirectCandidate
} from '../transport/direct.js';
import type { SecretStore } from './secrets.js';
import { type Connection, type ConnectionStore, newConnectionId } from './store.js';
import { validateConnectionUrl } from './url-policy.js';

export type ConnectionCandidateInput = {
	label: string;
	baseUrl: string;
	auth: ResolvedAuth;
};

export type VerifiedConnectionCandidate = ConnectionCandidateInput & {
	readonly verification: 'verified';
};

export type CandidateFailureReason =
	| 'invalid-input'
	| 'invalid-url'
	| Exclude<CandidateVerificationResult['status'], 'verified'>;

export type VerifyConnectionCandidateResult =
	| { ok: true; candidate: VerifiedConnectionCandidate }
	| { ok: false; reason: CandidateFailureReason; message: string; guideUrl?: string };

export type SaveVerifiedConnectionDependencies = {
	store: Pick<ConnectionStore, 'getActiveId' | 'add' | 'remove' | 'compareAndSetActive'>;
	secrets: Pick<SecretStore, 'set' | 'delete'>;
	activate(id: string, expectedActiveId?: string): Promise<void>;
	refresh(): Promise<void>;
	createId?: () => string;
};

export type SaveVerifiedConnectionResult =
	| { ok: true; connection: Connection }
	| { ok: false; error: string };

const SAVE_ERROR = 'Could not save this connection. No changes were kept. Try again.';
const ROLLBACK_ERROR =
	'Could not save this connection, and cleanup was incomplete. Review saved connections before trying again.';

function canonicalBaseUrl(rawUrl: string): string {
	return new URL(rawUrl.trim()).toString().replace(/\/+$/, '');
}

function verificationFailure(
	status: Exclude<CandidateVerificationResult['status'], 'verified'>
): Extract<VerifyConnectionCandidateResult, { ok: false }> {
	switch (status) {
		case 'credentials-rejected':
			return {
				ok: false,
				reason: status,
				message:
					'The address responded, but it rejected these credentials. Check them or use a new pairing code.'
			};
		case 'wrong-endpoint':
			return {
				ok: false,
				reason: status,
				message:
					'This address did not respond like OpenPalm. Check the address; Guardian addresses end in /oc.'
			};
		case 'rate-limited':
			return {
				ok: false,
				reason: status,
				message: 'This OpenPalm is receiving too many requests. Wait a moment and try again.'
			};
		case 'target-not-ready':
			return {
				ok: false,
				reason: status,
				message: 'This OpenPalm is not ready yet. Wait for it to finish starting, then try again.'
			};
		case 'mixed-content':
			return {
				ok: false,
				reason: status,
				message:
					'This secure page cannot connect to a plain-HTTP remote address. Use an https:// address.'
			};
		case 'network-uncertain':
			return {
				ok: false,
				reason: status,
				message:
					'The browser could not reach this OpenPalm. Check the address, network, CORS settings, and firewall, then try again.'
			};
	}
}

/** Validate and directly verify a candidate before any persistence occurs. */
export async function verifyConnectionCandidate(
	input: ConnectionCandidateInput,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch
): Promise<VerifyConnectionCandidateResult> {
	const label = input.label.trim();
	if (!label) {
		return { ok: false, reason: 'invalid-input', message: 'Enter a name for this OpenPalm.' };
	}

	const urlVerdict = validateConnectionUrl(input.baseUrl.trim());
	if (!urlVerdict.ok) {
		return {
			ok: false,
			reason: urlVerdict.reason === 'insecure-remote' ? 'mixed-content' : 'invalid-url',
			message: urlVerdict.message,
			...(urlVerdict.reason === 'insecure-remote' ? { guideUrl: urlVerdict.guideUrl } : {})
		};
	}

	if (input.auth.mode === 'basic' && !input.auth.password) {
		return { ok: false, reason: 'invalid-input', message: 'Enter the connection password.' };
	}

	const candidate: ConnectionCandidateInput = {
		label,
		baseUrl: canonicalBaseUrl(input.baseUrl),
		auth:
			input.auth.mode === 'basic'
				? {
						mode: 'basic',
						username: input.auth.username?.trim() || 'opencode',
						password: input.auth.password
					}
				: { mode: 'none' }
	};
	const result = await verifyDirectCandidate(candidate.baseUrl, candidate.auth, fetchImpl);
	if (result.status !== 'verified') return verificationFailure(result.status);
	return { ok: true, candidate: { ...candidate, verification: 'verified' } };
}

async function attempt(operation: () => Promise<void>): Promise<boolean> {
	try {
		await operation();
		return true;
	} catch {
		// Rollback is exhaustive: one failed cleanup must not skip the rest.
		return false;
	}
}

/** Save and activate an already-verified candidate as one compensated operation. */
export async function saveVerifiedConnection(
	candidate: VerifiedConnectionCandidate,
	dependencies: SaveVerifiedConnectionDependencies
): Promise<SaveVerifiedConnectionResult> {
	const verdict = validateConnectionUrl(candidate.baseUrl);
	if (
		candidate.verification !== 'verified' ||
		!candidate.label.trim() ||
		!verdict.ok ||
		(candidate.auth.mode === 'basic' && !candidate.auth.password)
	) {
		return { ok: false, error: SAVE_ERROR };
	}

	const createId = dependencies.createId ?? newConnectionId;
	const connectionId = createId();
	const secretRef = candidate.auth.mode === 'basic' ? createId() : null;
	let previousActiveId: string | null;
	try {
		previousActiveId = await dependencies.store.getActiveId();
	} catch {
		return { ok: false, error: SAVE_ERROR };
	}

	let secretWritten = false;
	let connectionWritten = false;
	let activationAttempted = false;
	try {
		if (candidate.auth.mode === 'basic' && secretRef) {
			await dependencies.secrets.set(secretRef, {
				username: candidate.auth.username,
				password: candidate.auth.password
			});
			secretWritten = true;
		}
		const connection = await dependencies.store.add({
			id: connectionId,
			label: candidate.label,
			baseUrl: candidate.baseUrl,
			auth:
				candidate.auth.mode === 'basic' && secretRef
					? { mode: 'basic', username: candidate.auth.username ?? 'opencode', secretRef }
					: { mode: 'none' }
		});
		connectionWritten = true;
		activationAttempted = true;
		await dependencies.activate(connection.id);
		await dependencies.refresh();
		return { ok: true, connection };
	} catch {
		let cleanupComplete = true;
		if (activationAttempted) {
			if (previousActiveId) {
				if (!(await attempt(() => dependencies.activate(previousActiveId, connectionId)))) {
					cleanupComplete = false;
				}
			} else if (
				!(await attempt(async () => {
					await dependencies.store.compareAndSetActive(connectionId, null);
				}))
			) {
				cleanupComplete = false;
			}
		}
		if (connectionWritten && !(await attempt(async () => void (await dependencies.store.remove(connectionId))))) {
			cleanupComplete = false;
		}
		if (
			secretWritten &&
			secretRef &&
			!(await attempt(() => dependencies.secrets.delete(secretRef)))
		) {
			cleanupComplete = false;
		}
		if (activationAttempted && !(await attempt(() => dependencies.refresh()))) {
			cleanupComplete = false;
		}
		return { ok: false, error: cleanupComplete ? SAVE_ERROR : ROLLBACK_ERROR };
	}
}

/** Consume only `#pair=`, returning a credential-free same-origin history path. */
export function pairingFragment(url: URL): { code: string | null; cleanPath: string } {
	const fragment = new URLSearchParams(url.hash.slice(1));
	const code = fragment.get('pair');
	if (code === null) return { code: null, cleanPath: `${url.pathname}${url.search}${url.hash}` };

	fragment.delete('pair');
	const remainingFragment = fragment.toString();
	return {
		code,
		cleanPath: `${url.pathname}${url.search}${remainingFragment ? `#${remainingFragment}` : ''}`
	};
}
