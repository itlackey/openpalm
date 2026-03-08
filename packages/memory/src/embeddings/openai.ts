/**
 * OpenAI-compatible embedder adapter. Uses fetch (no SDK dependency).
 */
import type { Embedder } from './base.js';
import type { EmbedderProviderConfig } from '../types.js';

export class OpenAIEmbedder implements Embedder {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private dimensions?: number;

  constructor(config: EmbedderProviderConfig['config']) {
    this.apiKey = config.apiKey ?? '';
    this.baseUrl = (config.baseUrl as string)?.replace(/\/+$/, '') ?? 'https://api.openai.com/v1';
    this.model = config.model ?? 'text-embedding-3-small';
    this.dimensions = config.dimensions;
  }

  async embed(text: string): Promise<number[]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: text,
    };
    if (this.dimensions) {
      body.dimensions = this.dimensions;
    }

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI Embeddings API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      data: { embedding: number[] }[];
    };

    return data.data[0].embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const body: Record<string, unknown> = {
      model: this.model,
      input: texts,
    };
    if (this.dimensions) {
      body.dimensions = this.dimensions;
    }

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI Embeddings API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as {
      data: { embedding: number[]; index: number }[];
    };

    // Sort by index to preserve input order
    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}
