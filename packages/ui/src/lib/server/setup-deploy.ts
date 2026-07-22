import {
  backupSetupInputs,
  isSetupComplete,
  markSetupComplete,
  readDeployJournal,
  resolveDeployJournalPath,
  resolveOpenPalmHome,
  runDeploy,
  type ControlPlaneState,
  type DeployEntry,
  type DeployPhase,
} from '@openpalm/lib';
import { clearLaunchRoutingCache } from '$lib/server/landing.js';

export type { DeployEntry, DeployPhase };

type DeployState = {
  deploying: boolean;
  interrupted?: boolean;
  setupComplete: boolean;
  deployStatus: DeployEntry[];
  deployError: string | null;
  imageWarning: string | null;
  phase: DeployPhase;
};

let _state: DeployState = {
  deploying: false,
  setupComplete: false,
  deployStatus: [],
  deployError: null,
  imageWarning: null,
  phase: 'writing-config',
};

let _deployPromise: Promise<void> | null = null;

function deployStateFromJournal(state: ControlPlaneState): DeployState {
  const journal = readDeployJournal(resolveDeployJournalPath(state));
  return {
    deploying: journal.deploying,
    interrupted: journal.interrupted,
    setupComplete: journal.setupComplete || isSetupComplete(resolveOpenPalmHome()),
    deployStatus: journal.deployStatus,
    deployError: journal.deployError,
    imageWarning: journal.imageWarning,
    phase: journal.phase,
  };
}

export function getDeployState(state?: ControlPlaneState): DeployState {
  if (state) {
    _state = deployStateFromJournal(state);
  } else if (!_state.setupComplete && !_state.deploying && isSetupComplete(resolveOpenPalmHome())) {
    _state.setupComplete = true;
  }
  return { ..._state, deployStatus: _state.deployStatus.map((entry) => ({ ...entry })) };
}

export function resetDeployState(): void {
  _state = {
    deploying: false,
    setupComplete: false,
    deployStatus: [],
    deployError: null,
    imageWarning: null,
    phase: 'writing-config',
  };
}

export function startDeploy(state: ControlPlaneState): void {
  if (_deployPromise) {
    _state.deployError = 'install_in_progress: A deploy is already running. Wait for it to finish.';
    return;
  }

  _deployPromise = (async () => {
    await runDeploy(state, {
      journalPath: resolveDeployJournalPath(state),
      onUpdate(progress) {
        _state = {
          deploying: progress.deploying,
          interrupted: progress.interrupted,
          setupComplete: progress.setupComplete,
          deployStatus: progress.deployStatus,
          deployError: progress.deployError,
          imageWarning: progress.imageWarning,
          phase: progress.phase,
        };
      },
      markSetupComplete() {
        markSetupComplete(state);
        clearLaunchRoutingCache();
      },
    });
  })().finally(() => {
    _deployPromise = null;
  });
}

export function prepareSetupRestorePoint(state: ControlPlaneState): string | null {
  return backupSetupInputs(state);
}
