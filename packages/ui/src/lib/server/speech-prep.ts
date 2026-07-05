import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getState } from './state.js';
import { getCurrentConfig, type RawConfig } from './opencode/config.js';
import { opencodeFetch } from './opencode/http.js';

export type SpeechPrepMode = 'chat_reply';

type OpenCodeSessionCreate = { id?: string };
type OpenCodeMessagePart = { type?: string; text?: string };
type OpenCodeMessageResponse = { parts?: OpenCodeMessagePart[] };

function personaPath(): string {
  return join(getState().configDir, 'assistant', 'persona.md');
}

function readPersona(): string {
  const path = personaPath();
  if (!existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf-8').trim();
  } catch {
    return '';
  }
}

function extractText(response: OpenCodeMessageResponse): string {
  return (response.parts ?? [])
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text?.trim() ?? '')
    .join(' ')
    .trim();
}

function buildPrompt(input: {
  userText: string;
  assistantText?: string;
  persona: string;
}): string {
  const personaBlock = input.persona
    ? input.persona
    : 'No persona markdown is configured. Use a neutral, helpful, conversational tone.';

  return [
    'You are preparing a spoken summary for text-to-speech.',
    'Return only the exact words to speak.',
    'Rewrite the final assistant reply into a concise, natural, conversational response.',
    'Preserve the meaning and important caveats.',
    'Keep it brief enough for audio playback.',
    'Do not use markdown, lists, or quotes.',
    '',
    'Persona markdown:',
    personaBlock,
    '',
    'User request:',
    input.userText,
    '',
    'Final assistant reply:',
    input.assistantText ?? '',
  ].join('\n');
}

function resolveSpeechModel(config: RawConfig): string | null {
  const small = typeof config.small_model === 'string' ? config.small_model.trim() : '';
  if (small) return small;
  const main = typeof config.model === 'string' ? config.model.trim() : '';
  return main || null;
}

async function loadSpeechConfig(): Promise<RawConfig> {
  try {
    return await opencodeFetch<RawConfig>('/config');
  } catch {
    return getCurrentConfig();
  }
}

export async function prepareSpeechText(input: {
  mode: SpeechPrepMode;
  userText: string;
  assistantText?: string;
}): Promise<string | null> {
  const userText = input.userText.trim();
  if (!userText) return null;
  if (!input.assistantText?.trim()) return null;

  const persona = readPersona();
  const config = await loadSpeechConfig();
  const model = resolveSpeechModel(config);
  const prompt = buildPrompt({
    userText,
    assistantText: input.assistantText?.trim(),
    persona,
  });

  let sessionId = '';
  try {
    const created = await opencodeFetch<OpenCodeSessionCreate>('/session', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    sessionId = typeof created.id === 'string' ? created.id : '';
    if (!sessionId) return null;

    const response = await opencodeFetch<OpenCodeMessageResponse>(`/session/${encodeURIComponent(sessionId)}/message`, {
      method: 'POST',
      body: JSON.stringify({
        parts: [{ type: 'text', text: prompt }],
        ...(model ? { model } : {}),
      }),
    });
    return extractText(response) || null;
  } finally {
    if (sessionId) {
      await opencodeFetch(`/session/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
  }
}
