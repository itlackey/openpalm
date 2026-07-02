import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ControlPlaneState } from './types.js';
import { stateEnvFile } from './home.js';
import type { HostIdentity, OwnershipDecision } from './host-identity.js';
import { hostIdentityMatches } from './host-identity.js';
import { discoverHomeBindMountSources } from './config-persistence.js';

export type ReconcileDecision = {
  decision: OwnershipDecision;
  canaries: Array<{ path: string; uid: number; gid: number }>;
  previousIdentity: HostIdentity | null;
  currentIdentity: HostIdentity;
};

export function ownershipRepairPaths(state: ControlPlaneState, opts?: { includeServices?: string[] }): string[] {
  const discovered = discoverHomeBindMountSources(state, opts).map((mount) => mount.isFile ? dirname(mount.path) : mount.path);
  const deduped = [...new Set(discovered)];
  const base = [
    `${state.homeDir}/state`,
    `${state.homeDir}/knowledge`,
    state.workspaceDir,
  ];
  return [...new Set([...base, ...deduped])];
}

export function ownershipCanaryPaths(state: ControlPlaneState): string[] {
  return [
    stateEnvFile(state.homeDir),
    ...ownershipRepairPaths(state),
  ];
}

export function readCanaryOwners(paths: string[]): Array<{ path: string; uid: number; gid: number }> {
  const owners: Array<{ path: string; uid: number; gid: number }> = [];
  for (const path of paths) {
    try {
      if (!existsSync(path)) continue;
      const stat = statSync(path);
      owners.push({ path, uid: stat.uid, gid: stat.gid });
    } catch {
      continue;
    }
  }
  return owners;
}

export function decideOwnershipFromCanaries(input: {
  currentIdentity: HostIdentity;
  previousIdentity: HostIdentity | null;
  canaries: Array<{ path: string; uid: number; gid: number }>;
}): OwnershipDecision {
  const { currentIdentity, previousIdentity, canaries } = input;
  const allMatch = canaries.length > 0 && canaries.every((canary) =>
    canary.uid === currentIdentity.uid && canary.gid === currentIdentity.gid,
  );
  const anyMatch = canaries.some((canary) =>
    canary.uid === currentIdentity.uid && canary.gid === currentIdentity.gid,
  );

  if (allMatch) return 'match';
  if (!previousIdentity || hostIdentityMatches(currentIdentity, previousIdentity)) return 'drift';
  return anyMatch ? 'drift' : 'swap';
}

export function buildReconcileDecision(input: {
  state: ControlPlaneState;
  currentIdentity: HostIdentity;
  previousIdentity: HostIdentity | null;
}): ReconcileDecision {
  const canaries = readCanaryOwners(ownershipCanaryPaths(input.state));
  return {
    decision: decideOwnershipFromCanaries({
      currentIdentity: input.currentIdentity,
      previousIdentity: input.previousIdentity,
      canaries,
    }),
    canaries,
    previousIdentity: input.previousIdentity,
    currentIdentity: input.currentIdentity,
  };
}
