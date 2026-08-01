/**
 * K5 residual: the project-collision fail-closed message must name the
 * actual cause. Before this test, EVERY exhausted-retry fallthrough — whether
 * Docker was simply unreachable for all three attempts, or Docker answered
 * fine but returned a foreign project with no trustworthy working_dir label —
 * produced the identical "Docker returned an existing project without a
 * trustworthy working_dir label" copy. That's factually wrong for the
 * "Docker could not be queried" case: no project (labelled or not) was ever
 * actually seen.
 *
 * Mocks docker.js the same way deploy-phase-contract.test.ts does: mock.module()
 * leaks across test files sharing this bun test process, so every test restores
 * the real implementation afterward.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realDocker from './docker.js';

const realApplyStack = realDocker.applyStack;
const realComposePs = realDocker.composePs;
const realDetectExistingProject = realDocker.detectExistingProject;

afterEach(() => {
	mock.restore();
	mock.module('./docker.js', () => ({
		...realDocker,
		applyStack: realApplyStack,
		composePs: realComposePs,
		detectExistingProject: realDetectExistingProject
	}));
});

function withDeployEnv(homeDir: string, run: () => Promise<void>): Promise<void> {
	const saved = {
		OP_HOME: process.env.OP_HOME,
		OP_SKIP_COMPOSE_PREFLIGHT: process.env.OP_SKIP_COMPOSE_PREFLIGHT,
		OP_SKIP_OWNERSHIP_RECONCILE: process.env.OP_SKIP_OWNERSHIP_RECONCILE,
		OP_UI_LOGIN_PASSWORD: process.env.OP_UI_LOGIN_PASSWORD
	};
	process.env.OP_HOME = homeDir;
	process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
	process.env.OP_SKIP_OWNERSHIP_RECONCILE = '1';
	process.env.OP_UI_LOGIN_PASSWORD = 'test-password-for-deploy-collision-test';
	return run().finally(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key as keyof NodeJS.ProcessEnv];
			else process.env[key as keyof NodeJS.ProcessEnv] = value;
		}
	});
}

describe('runDeploy project-collision fail-closed message names the real cause', () => {
	test('Docker unreachable on every attempt -> blames the query, not a bogus label', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-collision-docker-down-'));
		try {
			await withDeployEnv(homeDir, async () => {
				const detectExistingProjectMock = mock(async () => ({
					exists: false,
					isOurs: false,
					workingDir: '',
					error: 'Cannot connect to the Docker daemon'
				}));
				mock.module('./docker.js', () => ({
					...realDocker,
					detectExistingProject: detectExistingProjectMock
				}));

				const { runDeploy } = await import(`./deploy.js?collision-docker-down=${Math.random()}`);
				const { createState } = await import(
					`./lifecycle.js?collision-docker-down-state=${Math.random()}`
				);
				const state = createState();

				const result = await runDeploy(state);

				expect(result.deployError).toContain('could not be queried');
				expect(result.deployError).toContain('Cannot connect to the Docker daemon');
				expect(result.deployError).not.toContain('trustworthy working_dir label');
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	}, 15_000);

	test('a foreign project with no working_dir label -> blames the untrustworthy label', async () => {
		const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-collision-unlabeled-'));
		try {
			mkdirSync(join(homeDir, 'state'), { recursive: true });
			await withDeployEnv(homeDir, async () => {
				const detectExistingProjectMock = mock(async () => ({
					exists: true,
					isOurs: false,
					workingDir: ''
				}));
				mock.module('./docker.js', () => ({
					...realDocker,
					detectExistingProject: detectExistingProjectMock
				}));

				const { runDeploy } = await import(`./deploy.js?collision-unlabeled=${Math.random()}`);
				const { createState } = await import(
					`./lifecycle.js?collision-unlabeled-state=${Math.random()}`
				);
				const state = createState();

				const result = await runDeploy(state);

				expect(result.deployError).toContain('trustworthy working_dir label');
				expect(result.deployError).not.toContain('could not be queried');
			});
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	}, 15_000);
});
