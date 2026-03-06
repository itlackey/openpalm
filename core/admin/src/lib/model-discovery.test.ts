import { describe, expect, test } from 'vitest';
import { mapModelDiscoveryError } from './model-discovery.js';

describe('mapModelDiscoveryError', () => {
  test('maps timeout errors to copy-exact timeout guidance', () => {
    expect(mapModelDiscoveryError({ reason: 'timeout', error: 'Request timed out after 5s' })).toBe(
      'Connection timed out. Verify base URL and network access.'
    );
  });

  test('maps missing base URL errors', () => {
    expect(mapModelDiscoveryError({ reason: 'missing_base_url', error: 'No base URL configured' })).toBe(
      'Base URL is required for this provider.'
    );
  });

  test('passes through provider HTTP message', () => {
    expect(mapModelDiscoveryError({ reason: 'provider_http', error: 'Provider API returned 401' })).toBe(
      'Provider API returned 401'
    );
  });

  test('falls back to generic network copy', () => {
    expect(mapModelDiscoveryError({ reason: 'network', error: 'connection refused' })).toBe(
      'Network error — unable to reach admin API.'
    );
  });
});
