import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import type { OperatorIds } from './operator-ids.js';
import { resolveOperatorIds } from './operator-ids.js';
import { writeFileAtomic } from './fs-atomic.js';

export type HostIdentity = {
  kind: string;
  host: string;
  uid: number | null;
  gid: number | null;
};

export type OwnershipDecision = 'match' | 'drift' | 'swap';

export function detectHostIdentity(homeDir: string): HostIdentity {
  const ids = resolveOperatorIds(homeDir);
  return {
    kind: process.platform,
    host: hostname(),
    uid: ids?.uid ?? null,
    gid: ids?.gid ?? null,
  };
}

export function hostIdentityMatches(a: HostIdentity | null, b: HostIdentity | null): boolean {
  if (!a || !b) return false;
  const aIdsMissing = a.uid === null || a.gid === null;
  const bIdsMissing = b.uid === null || b.gid === null;
  if (aIdsMissing !== bIdsMissing) return false;
  if (aIdsMissing && bIdsMissing) {
    return a.kind === b.kind && a.host === b.host;
  }
  return a.kind === b.kind && a.uid === b.uid && a.gid === b.gid;
}

export function classifyOwnershipDecision(input: {
  current: HostIdentity;
  previous: HostIdentity | null;
  canaryOwner: OperatorIds | null;
}): OwnershipDecision {
  const { current, previous, canaryOwner } = input;
  if (canaryOwner && canaryOwner.uid === current.uid && canaryOwner.gid === current.gid) {
    return 'match';
  }
  if (!previous || hostIdentityMatches(current, previous)) {
    return 'drift';
  }
  return 'swap';
}

export function readHostIdentity(path: string): HostIdentity | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HostIdentity>;
    if (typeof parsed.kind !== 'string' || typeof parsed.host !== 'string') return null;
    const uidIsNumber = typeof parsed.uid === 'number';
    const gidIsNumber = typeof parsed.gid === 'number';
    const uidIsNullish = parsed.uid === null || parsed.uid === undefined;
    const gidIsNullish = parsed.gid === null || parsed.gid === undefined;
    if (!((uidIsNumber && gidIsNumber) || (uidIsNullish && gidIsNullish))) return null;
    return {
      kind: parsed.kind,
      host: parsed.host,
      uid: uidIsNumber ? parsed.uid as number : null,
      gid: gidIsNumber ? parsed.gid as number : null,
    };
  } catch {
    return null;
  }
}

export function writeHostIdentity(path: string, identity: HostIdentity): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, JSON.stringify(identity, null, 2) + '\n');
}
