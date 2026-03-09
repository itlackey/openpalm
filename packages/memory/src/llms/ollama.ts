/**
 * Ollama LLM adapter. Uses the Ollama HTTP API directly (no SDK dependency).
 */
import type { LLM } from './base.js';
import type { Message, LLMResponse, LLMProviderConfig } from '../types.js';

export class OllamaLLM implements LLM {
  private baseUrl: string;
  private model: string;

  constructor(config: LLMProviderConfig['config']) {
    this.baseUrl = (config.baseUrl as string)?.replace(/\/+$/, '') ?? 'http://localhost:11434';
    this.model = config.model ?? 'llama3.1:8b';
  }

  async generateResponse(
    messages: Message[],
    responseFormat?: { type: string },
  ): Promise<string | LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
    };

    if (responseFormat?.type === 'json_object') {
      body.format = 'json';
    }

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      message?: { content: string; role: string };
    };

    return data.message?.content ?? '';
  }
}
