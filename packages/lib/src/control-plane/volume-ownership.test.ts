import { describe, expect, it } from 'bun:test';
import { SERVICE_NAMED_VOLUMES } from './volume-ownership.js';

describe('SERVICE_NAMED_VOLUMES (#585 — the three /opt/openpalm volumes are retired)', () => {
  it('shrinks to only assistant-persistent — guardian-cache/assistant-artifacts/portal-cache are gone', () => {
    expect(SERVICE_NAMED_VOLUMES).toEqual({ assistant: ['assistant-persistent'] });
  });

  it('no longer lists a named volume to repair for guardian, discord, or slack', () => {
    expect(SERVICE_NAMED_VOLUMES.guardian).toBeUndefined();
    expect(SERVICE_NAMED_VOLUMES.discord).toBeUndefined();
    expect(SERVICE_NAMED_VOLUMES.slack).toBeUndefined();
  });
});
