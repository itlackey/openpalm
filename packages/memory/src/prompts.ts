/**
 * Prompt templates for fact extraction and memory management.
 * Ported from mem0-ts/src/oss/src/prompts/index.ts.
 */
import type { Message, MemoryItem } from './types.js';

/**
 * Build messages for the fact extraction LLM call.
 * The LLM returns a JSON object: { facts: string[] }
 */
export function getFactRetrievalMessages(
  parsedMessages: string,
  customPrompt?: string,
): Message[] {
  const systemPrompt = customPrompt ?? DEFAULT_FACT_EXTRACTION_PROMPT;
  return [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `Input:\n${parsedMessages}\n\nReturn a valid JSON object with a "facts" key containing an array of extracted facts.`,
    },
  ];
}

/**
 * Build messages for the memory update decision LLM call.
 * The LLM decides which memories to ADD, UPDATE, DELETE, or leave as NONE.
 */
export function getUpdateMemoryMessages(
  retrievedFacts: string[],
  existingMemories: MemoryItem[],
): Message[] {
  const existingText =
    existingMemories.length > 0
      ? existingMemories
          .map((m, i) => `[${i}] id=${m.id}: ${m.content}`)
          .join('\n')
      : '(none)';

  const newFactsText = retrievedFacts.map((f, i) => `[${i}] ${f}`).join('\n');

  return [
    { role: 'system', content: UPDATE_MEMORY_PROMPT },
    {
      role: 'user',
      content: `Existing memories:\n${existingText}\n\nNew facts:\n${newFactsText}\n\nReturn a valid JSON object with a "memory" key containing an array of operations.`,
    },
  ];
}

// ── Prompt Constants ──────────────────────────────────────────────────

const DEFAULT_FACT_EXTRACTION_PROMPT = `You are a Personal Information Organizer, specialized in accurately storing facts, user memories, and preferences. Your primary role is to extract relevant pieces of information from conversations and organize them into distinct, manageable facts.

Types of information to extract:
1. Personal preferences (likes, dislikes, favorites)
2. Important personal details (name, age, location, occupation)
3. Plans and intentions (upcoming events, goals)
4. Activity preferences (hobbies, routines)
5. Health and wellness information
6. Professional information (job, skills, projects)
7. Miscellaneous details that may be useful later
8. Basic facts and statements

Guidelines:
- Extract facts from the user's messages. Do NOT extract from system or assistant messages unless they contain user-provided information.
- Each fact should be a single, clear, concise statement.
- Detect the user's language and store facts in that same language.
- Break down compound statements into individual facts.
- If no facts can be extracted, return an empty array.

You MUST return a valid JSON object with a "facts" key containing an array of strings. Do NOT wrap the response in markdown code blocks.`;

const UPDATE_MEMORY_PROMPT = `You are a memory management system. You will be given existing memories and newly extracted facts. Your job is to decide what to do with each new fact.

For each new fact, choose one of these operations:
- ADD: The fact is genuinely new information not present in existing memories. Provide the full text.
- UPDATE: The fact updates or adds detail to an existing memory. Provide the existing memory id and the new, merged text.
- DELETE: The fact contradicts an existing memory, making it obsolete. Provide the memory id to delete.
- NONE: The fact is already captured by an existing memory. No action needed.

Guidelines:
- If a new fact conveys the same information as an existing memory, choose NONE.
- If a new fact has MORE information than an existing memory on the same topic, choose UPDATE with the richer version.
- If a new fact directly contradicts an existing memory, choose DELETE for the old one and ADD for the new one.
- Prefer fewer, richer memories over many small ones.

Return a valid JSON object with a "memory" key containing an array of objects, each with:
- "event": "ADD" | "UPDATE" | "DELETE" | "NONE"
- "id": (for UPDATE/DELETE only) the existing memory id
- "text": (for ADD/UPDATE only) the memory text

Do NOT wrap the response in markdown code blocks.`;
