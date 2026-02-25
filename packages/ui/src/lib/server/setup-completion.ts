import type { SetupManager } from '@openpalm/lib/admin/setup-manager';
import type { StackManager } from '@openpalm/lib/admin/stack-manager';
import type { EnsureCoreServicesReadyResult } from '@openpalm/lib/types';
import { applyStack } from '@openpalm/lib/admin/stack-apply-engine';
import {
	composeAction,
	SetupStartupServices
} from '@openpalm/lib/admin/compose-runner';
import { ensureCoreServicesReady } from '@openpalm/lib/admin/core-readiness';
import { syncAutomations } from '@openpalm/lib/admin/automations';
import { parseRuntimeEnvContent, updateRuntimeEnvContent } from '@openpalm/lib/admin/runtime-env';
import { generateToken } from '@openpalm/lib/tokens';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type SetupCompletionDependencies = {
	secretsEnvPath: string;
	existsSync: typeof existsSync;
	readFileSync: typeof readFileSync;
	parseRuntimeEnvContent: typeof parseRuntimeEnvContent;
	updateRuntimeEnvContent: typeof updateRuntimeEnvContent;
	generateToken: typeof generateToken;
	mkdirSync: typeof mkdirSync;
	dirname: typeof dirname;
	writeFileSync: typeof writeFileSync;
	applyStack: typeof applyStack;
	composeAction: typeof composeAction;
	syncAutomations: typeof syncAutomations;
	ensureCoreServicesReady: typeof ensureCoreServicesReady;
};

const defaultDependencies: SetupCompletionDependencies = {
	secretsEnvPath: '/config/secrets.env',
	existsSync,
	readFileSync,
	parseRuntimeEnvContent,
	updateRuntimeEnvContent,
	generateToken,
	mkdirSync,
	dirname,
	writeFileSync,
	applyStack,
	composeAction,
	syncAutomations,
	ensureCoreServicesReady
};

function ensurePostgresPassword(dependencies: SetupCompletionDependencies) {
	const current = dependencies.existsSync(dependencies.secretsEnvPath)
		? dependencies.readFileSync(dependencies.secretsEnvPath, 'utf8')
		: '';
	const existingSecrets = dependencies.parseRuntimeEnvContent(current);
	if (existingSecrets.POSTGRES_PASSWORD) return;

	const next = dependencies.updateRuntimeEnvContent(current, {
		POSTGRES_PASSWORD: dependencies.generateToken(32)
	});
	dependencies.mkdirSync(dependencies.dirname(dependencies.secretsEnvPath), { recursive: true });
	dependencies.writeFileSync(dependencies.secretsEnvPath, next, 'utf8');
}

export async function completeSetupOrchestration(
	setupManager: SetupManager,
	stackManager: StackManager,
	overrides: Partial<SetupCompletionDependencies> = {}
) {
	const dependencies = { ...defaultDependencies, ...overrides };
	ensurePostgresPassword(dependencies);
	const apply = await dependencies.applyStack(stackManager);
	const startup = await dependencies.composeAction('up', [...SetupStartupServices]);
	if (!startup.ok) throw new Error(`core_startup_failed:${startup.stderr}`);

	// Check runtime readiness convergence (non-blocking — setup completes regardless,
	// but the readiness result is surfaced so callers/UI can display status and retry)
	let readiness: EnsureCoreServicesReadyResult | undefined;
	try {
		readiness = await dependencies.ensureCoreServicesReady({
			targetServices: SetupStartupServices,
			maxAttempts: 6,
			pollIntervalMs: 2_000
		});
	} catch {
		// Best-effort: readiness check failure should not block setup completion
	}

	dependencies.syncAutomations(stackManager.listAutomations());
	const state = setupManager.completeSetup();
	return { state, apply, readiness };
}
