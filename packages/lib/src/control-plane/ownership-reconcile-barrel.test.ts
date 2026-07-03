import { describe, expect, test } from 'bun:test';
import {
  buildReconcileDecision,
  decideOwnershipFromCanaries,
  ownershipCanaryPaths,
  ownershipRepairPaths,
  readCanaryOwners,
  ownershipRepairMarkerFile,
  ownershipRepairMarkerMatches,
  writeOwnershipRepairMarker,
  reconcileHostOwnership,
  HostSwapBlockedError,
} from '../index.js';

describe('ownership reconcile barrel exports', () => {
  test('exports the reconcile helpers from the public lib barrel', () => {
    expect(typeof ownershipCanaryPaths).toBe('function');
    expect(typeof readCanaryOwners).toBe('function');
    expect(typeof decideOwnershipFromCanaries).toBe('function');
    expect(typeof ownershipRepairPaths).toBe('function');
    expect(typeof buildReconcileDecision).toBe('function');
    expect(typeof ownershipRepairMarkerFile).toBe('function');
    expect(typeof ownershipRepairMarkerMatches).toBe('function');
    expect(typeof writeOwnershipRepairMarker).toBe('function');
    expect(typeof reconcileHostOwnership).toBe('function');
    expect(typeof HostSwapBlockedError).toBe('function');
  });
});
