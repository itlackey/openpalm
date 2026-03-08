/**
 * Ollama embedder adapter. Uses the Ollama HTTP API directly.
 */
import type { Embedder } from './base.js';
import type { EmbedderProviderConfig } from '../types.js';

export class OllamaEmbedder implements Embedder {
  private baseUrl: string;
  private model: string;

  constructor(config: EmbedderProviderConfig['config']) {
    this.baseUrl = (config.baseUrl as string)?.replace(/\/+$/, '') ?? 'http://localhost:11434';
    this.model = config.model ?? 'nomic-embed-text:latest';
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: text }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollama Embed API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, input: texts }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollama Embed API error ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings;
  }
}
