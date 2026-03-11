import { describe, expect, test } from 'vitest';
import {
  mapConnectionTestError,
  mapModelDiscoveryError,
  mapDiscoveryResultToErrorCode,
} from './model-discovery.js';

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
      'Network error — unable to reach the provider. Verify the base URL and that the service is running.'
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

describe('mapConnectionTestError', () => {
  test('maps unauthorized errors', () => {
    expect(mapConnectionTestError({ errorCode: 'unauthorized' })).toBe(
      'Invalid API key. The provider rejected the credentials — double-check the key and try again.'
    );
  });

  test('maps not found errors', () => {
    expect(mapConnectionTestError({ errorCode: 'not_found' })).toBe(
      'Endpoint not found. Verify the Base URL is correct (most providers need a /v1 path).'
    );
  });

  test('maps timeout errors', () => {
    expect(mapConnectionTestError({ errorCode: 'timeout' })).toBe(
      "Couldn't reach the server — it may be down or the URL may be wrong. Confirm it's running and accessible."
    );
  });

  test('maps missing base URL errors', () => {
    expect(mapConnectionTestError({ errorCode: 'missing_base_url' })).toBe(
      'Base URL is required for this provider.'
    );
  });

  test('falls back to the provided error message', () => {
    expect(mapConnectionTestError({ errorCode: 'unknown', error: 'Bad gateway' })).toBe(
      'Bad gateway'
    );
  });

  test('falls back to generic copy when no error message is present', () => {
    expect(mapConnectionTestError({ errorCode: 'unknown' })).toBe(
      'Connection failed. Check the Base URL and API key.'
    );
  });
});
