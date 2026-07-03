import {
  buildAkmEndpoint,
  detectLocalProviders,
  fetchProviderModels,
  lookupEmbeddingDims,
  type ControlPlaneState,
  type LocalProviderDetection,
} from '@openpalm/lib';

const EMBEDDING_MODEL_HINT_RE = /(?:^|[-/_.])(embed|embedding|bge|gte|e5|nomic|mxbai|arctic-embed|minilm)/i;

const PREFERRED_EMBEDDING_MODELS: Record<string, string[]> = {
  ollama: [
    'mxbai-embed-large:latest',
    'mxbai-embed-large',
    'mxbai-embed-large-v1',
    'nomic-embed-text:latest',
    'nomic-embed-text',
    'snowflake-arctic-embed',
    'all-minilm',
  ],
  'model-runner': [
    'ai/mxbai-embed-large-v1',
  ],
  lmstudio: [
    'mxbai-embed-large-v1',
    'mxbai-embed-large',
    'nomic-embed-text',
  ],
};

export type EmbeddingProbeInput = {
  endpoint: string;
  model: string;
  apiKey?: string;
  provider?: string;
  dimension?: number;
};

export type EmbeddingProbeResult =
  | { ok: true; dimension: number; message: string; provider?: string }
  | { ok: false; message: string };

export type EmbeddingDetectionResult =
  | {
      ok: true;
      endpoint: string;
      model: string;
      provider: string;
      dimension: number;
      message: string;
    }
  | {
      ok: false;
      message: string;
    };

export function safeParseJsonObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isEmbeddingModel(provider: string, model: string): boolean {
  return lookupEmbeddingDims(provider, model) > 0 || EMBEDDING_MODEL_HINT_RE.test(model);
}

function compareModelPreference(provider: string, left: string, right: string): number {
  const preferred = PREFERRED_EMBEDDING_MODELS[provider] ?? [];
  const leftIdx = preferred.indexOf(left);
  const rightIdx = preferred.indexOf(right);
  if (leftIdx >= 0 || rightIdx >= 0) {
    if (leftIdx < 0) return 1;
    if (rightIdx < 0) return -1;
    return leftIdx - rightIdx;
  }

  const dimDelta = lookupEmbeddingDims(provider, right) - lookupEmbeddingDims(provider, left);
  if (dimDelta !== 0) return dimDelta;
  return left.localeCompare(right);
}

function bestEmbeddingModel(provider: string, models: string[]): string | null {
  const candidates = models.filter((model) => isEmbeddingModel(provider, model));
  if (candidates.length === 0) return null;
  return [...candidates].sort((left, right) => compareModelPreference(provider, left, right))[0] ?? null;
}

function detectionPriority(left: LocalProviderDetection, right: LocalProviderDetection): number {
  const order = ['ollama', 'model-runner', 'lmstudio'];
  return order.indexOf(left.provider) - order.indexOf(right.provider);
}

function describeUpstreamError(status: number, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const error = parsed.error;
    if (typeof error === 'string' && error) return `Embedding request failed (${status}): ${error}`;
    if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
      return `Embedding request failed (${status}): ${(error as Record<string, unknown>).message as string}`;
    }
    if (typeof parsed.message === 'string' && parsed.message) return `Embedding request failed (${status}): ${parsed.message}`;
  } catch {
    // Fall through to the generic message.
  }
  return `Embedding request failed (${status}).`;
}

export async function testEmbeddingSettings(input: EmbeddingProbeInput): Promise<EmbeddingProbeResult> {
  const endpoint = input.endpoint.trim();
  const model = input.model.trim();
  if (!endpoint) return { ok: false, message: 'Endpoint is required.' };
  if (!model) return { ok: false, message: 'Model is required.' };

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  const apiKey = input.apiKey?.trim() ?? '';
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        input: ['OpenPalm embedding settings test'],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const raw = await response.text();
    if (!response.ok) {
      return { ok: false, message: describeUpstreamError(response.status, raw) };
    }

    const parsed = safeParseJsonObject(raw);
    const items = Array.isArray(parsed?.data) ? (parsed.data as unknown[]) : [];
    const first = items[0];
    const embedding = first && typeof first === 'object' ? (first as Record<string, unknown>).embedding : undefined;
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((value) => typeof value === 'number')) {
      return { ok: false, message: 'Endpoint responded, but not with an OpenAI-compatible embeddings payload.' };
    }

    const dimension = embedding.length;
    const configuredDimension = typeof input.dimension === 'number' && input.dimension > 0 ? input.dimension : null;
    const message = configuredDimension && configuredDimension !== dimension
      ? `Embedding endpoint is working. Returned ${dimension} dimensions; the form has been updated to match.`
      : `Embedding endpoint is working. Returned ${dimension} dimensions.`;
    return { ok: true, dimension, message, provider: input.provider };
  } catch (error) {
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'Embedding request timed out after 10 seconds.'
      : error instanceof Error
        ? `Embedding request failed: ${error.message}`
        : 'Embedding request failed.';
    return { ok: false, message };
  }
}

export async function detectEmbeddingSettings(state: ControlPlaneState): Promise<EmbeddingDetectionResult> {
  const detected = (await detectLocalProviders())
    .filter((provider) => provider.available && provider.url)
    .sort(detectionPriority);

  for (const provider of detected) {
    const modelsResult = await fetchProviderModels(provider.provider, '', provider.url, state.homeDir);
    if (modelsResult.status !== 'ok') continue;
    const model = bestEmbeddingModel(provider.provider, modelsResult.models);
    if (!model) continue;

    const endpoint = buildAkmEndpoint(provider.provider, provider.url, '/embeddings');
    const probe = await testEmbeddingSettings({ endpoint, model, provider: provider.provider });
    if (!probe.ok) continue;

    return {
      ok: true,
      endpoint,
      model,
      provider: provider.provider,
      dimension: probe.dimension,
      message: `Detected ${provider.provider} embedding model ${model}.`,
    };
  }

  return {
    ok: false,
    message: 'No working local embedding endpoint was detected. Tried common runtimes such as Ollama, Docker Model Runner, and LM Studio.',
  };
}
