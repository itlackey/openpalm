/**
 * LLM interface — contract for language model adapters.
 */
import type { Message, LLMResponse } from '../types.js';

export interface LLM {
  /** Generate a response, optionally requesting JSON format or tool use. */
  generateResponse(
    messages: Message[],
    responseFormat?: { type: string },
    tools?: unknown[],
  ): Promise<string | LLMResponse>;
}
