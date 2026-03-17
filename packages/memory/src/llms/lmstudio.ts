/**
 * LM Studio LLM adapter. Uses the OpenAI-compatible chat completions API
 * but omits response_format (which LM Studio does not reliably support).
 * JSON output is requested via system prompt instructions instead.
 */
import type { LLM } from './base.js';
import type { Message, LLMResponse, LLMProviderConfig } from '../types.js';

export class LMStudioLLM implements LLM {
  private baseUrl: string;
  private model: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: LLMProviderConfig['config']) {
    this.baseUrl = (config.baseUrl as string)?.replace(/\/+$/, '') ?? 'http://localhost:1234/v1';
    this.model = config.model ?? 'default';
    this.temperature = (config.temperature as number) ?? 0.1;
    this.maxTokens = (config.maxTokens as number) ?? 2000;
  }

  async generateResponse(
    messages: Message[],
    responseFormat?: { type: string },
  ): Promise<string | LLMResponse> {
    const mapped = messages.map((m) => ({ role: m.role, content: m.content }));

    // When JSON is requested, prepend a system instruction instead of
    // using response_format (which LM Studio may reject or ignore).
    if (responseFormat?.type === 'json_object') {
      const hasSystemMsg = mapped.length > 0 && mapped[0].role === 'system';
      if (hasSystemMsg) {
        mapped[0] = {
          ...mapped[0],
          content: mapped[0].content + '\n\nIMPORTANT: You MUST respond with valid JSON only. No other text.',
        };
      } else {
        mapped.unshift({
          role: 'system',
          content: 'You MUST respond with valid JSON only. No other text.',
        });
      }
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: mapped,
      temperature: this.temperature,
      max_tokens: this.maxTokens,
    };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`LM Studio API error ${res.status}: ${text}`);
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
    if (!choice) throw new Error('No response from LM Studio');

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
