import type { SetupManager } from '@openpalm/lib/admin/setup-manager';
import type { StackManager } from '@openpalm/lib/admin/stack-manager';
import { completeSetupOrchestration } from './setup-completion';
import { getCoreReadinessSnapshot } from './core-readiness-state';

type CompleteSetupFn = typeof completeSetupOrchestration;

export async function completeSetupCommandResponse(
	setupManager: SetupManager,
	stackManager: StackManager,
	secretsEnvPath: string,
	completeSetup: CompleteSetupFn = completeSetupOrchestration
) {
	const result = await completeSetup(setupManager, stackManager, { secretsEnvPath });
	const coreReadiness = getCoreReadinessSnapshot();
	return { ok: true as const, data: result.state, apply: result.apply, readiness: result.readiness, coreReadiness };
}

export async function completeSetupRouteResponse(
	setupManager: SetupManager,
	stackManager: StackManager,
	secretsEnvPath: string,
	completeSetup: CompleteSetupFn = completeSetupOrchestration
) {
	const result = await completeSetup(setupManager, stackManager, { secretsEnvPath });
	const coreReadiness = getCoreReadinessSnapshot();
	return { ok: true as const, state: result.state, apply: result.apply, readiness: result.readiness, coreReadiness };
}
