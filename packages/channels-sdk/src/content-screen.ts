/**
 * Deterministic, in-process content pre-screen for inbound channel messages.
 *
 * This is the cheap first layer of the guardian's content-validation pipeline:
 * pure string heuristics (no model, no I/O, ~microseconds) that score a message
 * for prompt-injection / jailbreak / exfiltration signals. The guardian uses the
 * score to decide whether to escalate a message to the (expensive) LLM moderator.
 *
 * It is intentionally conservative: heuristics produce a *risk score*, not a
 * verdict. Blocking decisions are made downstream — heuristics only decide
 * "worth a closer look". Keeping this pure + deterministic makes it fully
 * unit-testable and free of false-positive blocking on their own.
 */

export type ContentSignal =
  | "injection_phrase"
  | "role_marker"
  | "chat_template_token"
  | "invisible_chars"
  | "unicode_tag_chars"
  | "large_base64_blob"
  | "exfiltration_phrase"
  | "near_size_limit";

export type ContentScreenResult = {
  /** 0 = clean. Higher = more suspicious. Unbounded but typically 0–10. */
  risk: number;
  /** Which heuristics fired, for audit + downstream prompting. */
  signals: ContentSignal[];
};

// ── Pattern banks ────────────────────────────────────────────────────────────
// Each entry is a (weight, regex). Weights are additive into the risk score.

const INJECTION_PATTERNS: Array<[number, RegExp]> = [
  [3, /\bignore\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|messages?|context)\b/i],
  [3, /\bdisregard\s+(?:all\s+|the\s+|your\s+)?(?:previous|prior|above|system|earlier)\b/i],
  [3, /\b(?:forget|override|bypass)\s+(?:all\s+|your\s+|the\s+)?(?:previous\s+)?(?:instructions?|rules?|guidelines?|system\s+prompt)\b/i],
  [2, /\byou\s+are\s+now\b/i],
  [2, /\bnew\s+instructions?\s*:/i],
  [2, /\bsystem\s+prompt\b/i],
  [2, /\b(?:enable|enter|activate)\s+(?:developer|debug|god|dan)\s+mode\b/i],
  [3, /\bjailbreak\b/i],
  [2, /\bpretend\s+(?:to\s+be|you(?:'| a)re|that\s+you)\b/i],
  [2, /\bact\s+as\s+(?:if\s+you|an?\s+)/i],
  [2, /\bdo\s+anything\s+now\b/i],
];

const EXFILTRATION_PATTERNS: Array<[number, RegExp]> = [
  [3, /\b(?:reveal|print|repeat|show|output|tell\s+me)\s+(?:your\s+|the\s+)?(?:system\s+prompt|initial\s+instructions?|prompt|guidelines?|rules?)\b/i],
  [3, /\bwhat\s+(?:are|were)\s+your\s+(?:original\s+|initial\s+|system\s+)?(?:instructions?|guidelines?|rules?|prompt)\b/i],
  [3, /\b(?:exfiltrate|leak|dump)\b.*\b(?:secret|token|key|credential|env|vault)\b/i],
  [2, /\bprint\s+(?:everything\s+)?(?:above|before\s+this)\b/i],
];

// Chat-template / role markers used to smuggle a fake conversation turn.
const CHAT_TEMPLATE_TOKENS: RegExp = /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|<\|eot_id\|>|<\|start_header_id\|>/i;

// Line-leading role markers (e.g. "system: ...", "assistant: ...").
const ROLE_MARKER: RegExp = /(?:^|\n)\s*(?:system|assistant|developer|tool)\s*:/i;

// Invisible / zero-width / bidi-control characters frequently used to hide
// instructions: ZWSP/ZWNJ/ZWJ, LRM/RLM, directional embeddings & overrides,
// word joiner, invisible math operators, BOM, soft hyphen.
const INVISIBLE_CHARS: RegExp = /[​-‏‪-‮⁠-⁤﻿­]/;

// Unicode "tag" block (U+E0000–U+E007F): invisible, used for hidden payloads.
const UNICODE_TAG_CHARS: RegExp = /[\u{E0000}-\u{E007F}]/u;

// A long unbroken base64-ish run can hide an encoded instruction payload.
const LARGE_BASE64: RegExp = /[A-Za-z0-9+/]{512,}={0,2}/;

const NEAR_SIZE_LIMIT = 9_000; // text cap is 10k; flag messages crowding it

// ── Screen ───────────────────────────────────────────────────────────────────

/**
 * Score a message's text (and optionally stringified metadata) for malicious
 * intent signals. Pure and deterministic.
 */
export function screenContent(
  text: string,
  metadata?: unknown,
): ContentScreenResult {
  const signals = new Set<ContentSignal>();
  let risk = 0;

  // Include metadata in the scan surface — it is forwarded and influences
  // routing, so injection can hide there too. Bounded to avoid pathological cost.
  const metaStr = metadata === undefined ? "" : safeStringify(metadata).slice(0, 4_000);
  const haystack = metaStr ? `${text}\n${metaStr}` : text;

  for (const [weight, re] of INJECTION_PATTERNS) {
    if (re.test(haystack)) { risk += weight; signals.add("injection_phrase"); break; }
  }
  for (const [weight, re] of EXFILTRATION_PATTERNS) {
    if (re.test(haystack)) { risk += weight; signals.add("exfiltration_phrase"); break; }
  }
  if (CHAT_TEMPLATE_TOKENS.test(haystack)) { risk += 3; signals.add("chat_template_token"); }
  if (ROLE_MARKER.test(haystack)) { risk += 1; signals.add("role_marker"); }
  if (INVISIBLE_CHARS.test(haystack)) { risk += 2; signals.add("invisible_chars"); }
  if (UNICODE_TAG_CHARS.test(haystack)) { risk += 4; signals.add("unicode_tag_chars"); }
  if (LARGE_BASE64.test(haystack)) { risk += 2; signals.add("large_base64_blob"); }
  if (text.length >= NEAR_SIZE_LIMIT) { risk += 1; signals.add("near_size_limit"); }

  return { risk, signals: [...signals] };
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "";
  }
}
