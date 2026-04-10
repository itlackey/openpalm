/**
 * Azure OpenAI LLM adapter.
 *
 * Azure OpenAI uses deployment-based routing rather than model names in the
 * request body. The API also requires an api-version query parameter and
 * authenticates via the api-key header instead of Authorization: Bearer.
 *
 * Config:
 *   - baseUrl:    Azure OpenAI endpoint (e.g. https://<name>.openai.azure.com/)
 *   - model:      Deployment name (e.g. gpt-41-mini)
 *   - apiKey:     Azure OpenAI API key
 *   - apiVersion: API version (default: 2024-10-21)
 */
import type { LLM } from './base.js';
import type { Message, LLMResponse, LLMProviderConfig } from '../types.js';

export class AzureOpenAILLM implements LLM {
  private apiKey: string;
  private baseUrl: string;
  private deployment: string;
  private apiVersion: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: LLMProviderConfig['config']) {
    this.apiKey = config.apiKey ?? '';
    this.baseUrl = (config.baseUrl as string)?.replace(/\/+$/, '') ?? '';
    this.deployment = config.model ?? '';
    this.apiVersion = (config.apiVersion as string) ?? '2024-10-21';
    this.temperature = (config.temperature as number) ?? 0.1;
    this.maxTokens = (config.maxTokens as number) ?? 2000;
  }

  async generateResponse(
    messages: Message[],
    responseFormat?: { type: string },
  ): Promise<string | LLMResponse> {
    const body: Record<string, unknown> = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: this.temperature,
      max_completion_tokens: this.maxTokens,
    };

    if (responseFormat) {
      body.response_format = responseFormat;
    }

    const url = `${this.baseUrl}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Azure OpenAI API error ${res.status}: ${text}`);
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
    if (!choice) throw new Error('No response from Azure OpenAI');

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
