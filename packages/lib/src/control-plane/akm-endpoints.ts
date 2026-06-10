const AKM_OPENAI_STYLE_PROVIDERS = new Set([
  'deepseek',
  'google',
  'groq',
  'huggingface',
  'lmstudio',
  'mistral',
  'model-runner',
  'ollama',
  'openai',
  'openai-compatible',
  'together',
  'xai',
]);

export function normalizeAkmBaseUrl(provider: string, baseUrl?: string): string {
  let base = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!base) return '';

  base = base
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/embeddings\/?$/, '');

  if (provider === 'ollama') {
    base = base.replace(/\/api\/?$/, '');
  }

  if (!AKM_OPENAI_STYLE_PROVIDERS.has(provider) || /\/v\d+(?:\.\d+)?$/.test(base)) {
    return base;
  }

  return `${base}/v1`;
}

export function buildAkmEndpoint(provider: string, baseUrl: string | undefined, suffix: string): string {
  const base = normalizeAkmBaseUrl(provider, baseUrl);
  return base ? `${base}${suffix}` : '';
}
