type ModelDiscoveryLike = {
  error?: string;
  reason?: string;
  status?: 'ok' | 'recoverable_error';
};

export function mapModelDiscoveryError(result: ModelDiscoveryLike): string {
  if (!result.error) return '';
  if (result.reason === 'timeout') {
    return 'Connection timed out. Verify base URL and network access.';
  }
  if (result.reason === 'missing_base_url') {
    return 'Base URL is required for this provider.';
  }
  if (result.reason === 'provider_http') {
    return result.error;
  }
  return 'Network error — unable to reach the provider. Verify the base URL and that the service is running.';
}

export type ConnectionTestErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'timeout'
  | 'network'
  | 'missing_base_url'
  | 'unknown';

export function mapConnectionTestError(result: {
  error?: string;
  errorCode?: ConnectionTestErrorCode | string;
}): string {
  switch (result.errorCode) {
    case 'unauthorized':
      return 'Invalid API key. The provider rejected the credentials — double-check the key and try again.';
    case 'not_found':
      return 'Endpoint not found. Verify the Base URL is correct (most providers need a /v1 path).';
    case 'timeout':
      return "Couldn't reach the server — it may be down or the URL may be wrong. Confirm it's running and accessible.";
    case 'network':
      return 'Unable to connect to the provider. Verify the base URL and that the service is running.';
    case 'missing_base_url':
      return 'Base URL is required for this provider.';
    default:
      return result.error ?? 'Connection failed. Check the Base URL and API key.';
  }
}

export function mapDiscoveryResultToErrorCode(
  result: Pick<ModelDiscoveryLike, 'reason' | 'error'>
): ConnectionTestErrorCode {
  switch (result.reason) {
    case 'timeout':          return 'timeout';
    case 'missing_base_url': return 'missing_base_url';
    case 'network':          return 'network';
    case 'provider_http': {
      // Parse status from the error string produced by fetchProviderModels
      // e.g. "Provider API returned 401", "Ollama API returned 404"
      const match = /\b(\d{3})\b/.exec(result.error ?? '');
      const status = match ? Number(match[1]) : 0;
      if (status === 401 || status === 403) return 'unauthorized';
      if (status === 404)                    return 'not_found';
      return 'unknown';
    }
    default: return 'unknown';
  }
}
