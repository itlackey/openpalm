/**
 * In-memory cache for the core readiness snapshot.
 *
 * The snapshot is populated during setup completion orchestration and can be
 * polled by the UI through GET /setup/core-readiness. A retry triggers a fresh
 * readiness check and updates the snapshot.
 */
import type {
	CoreReadinessSnapshot,
	CoreReadinessPhase,
	CoreServiceReadinessCheck,
	CoreReadinessDiagnostics,
	EnsureCoreServicesReadyResult
} from '@openpalm/lib/types';

let _snapshot: CoreReadinessSnapshot | null = null;

export function getCoreReadinessSnapshot(): CoreReadinessSnapshot | null {
	return _snapshot;
}

export function setCoreReadinessPhase(
	phase: CoreReadinessPhase,
	checks: CoreServiceReadinessCheck[] = [],
	diagnostics: CoreReadinessDiagnostics = { failedServices: [] }
): CoreReadinessSnapshot {
	_snapshot = {
		phase,
		updatedAt: new Date().toISOString(),
		checks,
		diagnostics
	};
	return _snapshot;
}

export function applyReadinessResult(result: EnsureCoreServicesReadyResult): CoreReadinessSnapshot {
	const phase: CoreReadinessPhase = result.ok ? 'ready' : 'failed';
	return setCoreReadinessPhase(phase, result.checks, result.diagnostics);
}

/** Reset the snapshot (useful for tests). */
export function resetCoreReadinessSnapshot(): void {
	_snapshot = null;
}
