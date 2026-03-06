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
  return 'Network error — unable to reach admin API.';
}
