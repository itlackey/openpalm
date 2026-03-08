import { describe, expect, test } from 'vitest';
import { mapModelDiscoveryError, mapDiscoveryResultToErrorCode } from './model-discovery.js';

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

describe('mapDiscoveryResultToErrorCode', () => {
  test('maps reason:timeout to timeout', () => {
    expect(mapDiscoveryResultToErrorCode({ reason: 'timeout', error: 'timed out' })).toBe('timeout');
  });

  test('maps reason:missing_base_url to missing_base_url', () => {
    expect(mapDiscoveryResultToErrorCode({ reason: 'missing_base_url' })).toBe('missing_base_url');
  });

  test('maps reason:network to network', () => {
    expect(mapDiscoveryResultToErrorCode({ reason: 'network', error: 'ECONNREFUSED' })).toBe('network');
  });

  test('maps reason:provider_http with 401 to unauthorized', () => {
    expect(mapDiscoveryResultToErrorCode({ reason: 'provider_http', error: 'Provider API returned 401' })).toBe('unauthorized');
  });

  test('maps reason:provider_http with 403 to unauthorized', () => {
    expect(mapDiscoveryResultToErrorCode({ reason: 'provider_http', error: 'Provider API returned 403' })).toBe('unauthorized');
  });

  test('maps reason:provider_http with 404 to not_found', () => {
    expect(mapDiscoveryResultToErrorCode({ reason: 'provider_http', error: 'Provider API returned 404' })).toBe('not_found');
  });

  test('maps reason:provider_http with unknown status to unknown', () => {
    expect(mapDiscoveryResultToErrorCode({ reason: 'provider_http', error: 'Provider API returned 500' })).toBe('unknown');
  });

  test('maps reason:none (should not be called with ok result) to unknown', () => {
    expect(mapDiscoveryResultToErrorCode({ reason: 'none' })).toBe('unknown');
  });
});
