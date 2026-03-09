/**
 * OpenAI-compatible LLM adapter. Works with any OpenAI-compatible API
 * (OpenAI, Azure OpenAI, LM Studio, vLLM, etc.) via fetch.
 */
import type { LLM } from './base.js';
import type { Message, LLMResponse, LLMProviderConfig } from '../types.js';

export class OpenAILLM implements LLM {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: LLMProviderConfig['config']) {
    this.apiKey = config.apiKey ?? '';
    this.baseUrl = (config.baseUrl as string)?.replace(/\/+$/, '') ?? 'https://api.openai.com/v1';
    this.model = config.model ?? 'gpt-4o-mini';
    this.temperature = (config.temperature as number) ?? 0.1;
    this.maxTokens = (config.maxTokens as number) ?? 2000;
  }

  async generateResponse(
    messages: Message[],
    responseFormat?: { type: string },
  ): Promise<string | LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };

    if (responseFormat) {
      body.response_format = responseFormat;
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI API error ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      choices: {
        message: {
          content: string | null;
          role: string;
          tool_calls?: { function: { name: string; arguments: string } }[];
        };
      }[];
    };

    const choice = data.choices[0]?.message;
    if (!choice) throw new Error('No response from OpenAI');

    if (choice.tool_calls?.length) {
      return {
        content: choice.content ?? '',
        role: choice.role,
        toolCalls: choice.tool_calls.map((tc) => ({
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        })),
      };
    }

    return choice.content ?? '';
  }
}
