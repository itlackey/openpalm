/**
 * Azure OpenAI embedder adapter.
 *
 * Uses deployment-based routing, api-version query param, and api-key header.
 *
 * Config:
 *   - baseUrl:    Azure OpenAI endpoint (e.g. https://<name>.openai.azure.com/)
 *   - model:      Deployment name (e.g. text-embedding-3-large)
 *   - apiKey:     Azure OpenAI API key
 *   - apiVersion: API version (default: 2024-10-21)
 *   - dimensions: Embedding dimensions (optional)
 */
import type { Embedder } from './base.js';
import type { EmbedderProviderConfig } from '../types.js';

export class AzureOpenAIEmbedder implements Embedder {
  private apiKey: string;
  private baseUrl: string;
  private deployment: string;
  private apiVersion: string;
  private dimensions?: number;

  constructor(config: EmbedderProviderConfig['config']) {
    this.apiKey = config.apiKey ?? '';
    this.baseUrl = (config.baseUrl as string)?.replace(/\/+$/, '') ?? '';
    this.deployment = config.model ?? '';
    this.apiVersion = (config.apiVersion as string) ?? '2024-10-21';
    this.dimensions = config.dimensions;
  }

  private get url(): string {
    return `${this.baseUrl}/openai/deployments/${this.deployment}/embeddings?api-version=${this.apiVersion}`;
  }

  async embed(text: string): Promise<number[]> {
    const body: Record<string, unknown> = { input: text };
    if (this.dimensions) body.dimensions = this.dimensions;

    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': this.apiKey },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Azure OpenAI Embeddings API error ${res.status}: ${errBody}`);
    }

    const data = (await res.json()) as { data: { embedding: number[] }[] };
    if (!data.data?.length) throw new Error('Azure OpenAI Embeddings API returned no embeddings');
    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const body: Record<string, unknown> = { input: texts };
    if (this.dimensions) body.dimensions = this.dimensions;

    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': this.apiKey },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Azure OpenAI Embeddings API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
