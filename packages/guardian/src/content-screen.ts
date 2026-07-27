export type ContentSignal =
  | 'injection_phrase'
  | 'role_marker'
  | 'chat_template_token'
  | 'invisible_chars'
  | 'unicode_tag_chars'
  | 'large_base64_blob'
  | 'exfiltration_phrase'
  | 'near_size_limit';

export type ContentScreenResult = {
  risk: number;
  signals: ContentSignal[];
};

const INJECTION_PATTERNS: Array<[number, RegExp]> = [
  [3, /\bignore\s+(?:all\s+|the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|messages?|context)\b/i],
  [3, /\bdisregard\s+(?:all\s+|the\s+|your\s+)?(?:previous|prior|above|system|earlier)\b/i],
  [3, /\b(?:forget|override|bypass)\s+(?:all\s+|your\s+|the\s+)?(?:previous\s+)?(?:instructions?|rules?|guidelines?|system\s+prompt)\b/i],
  // G6: these four are unambiguous single-phrase jailbreak markers — raised
  // to 3 so a LONE occurrence alone reaches ESCALATE_THRESHOLD (3 by default
  // in moderation.ts) instead of sliding through as sub-threshold "allow".
  // Validated against the shipped DISCORD_SESSION_PREAMBLE (see
  // content-screen.test.ts) so first-turn preambles are not blocked.
  [3, /\byou\s+are\s+now\b/i],
  [2, /\bnew\s+instructions?\s*:/i],
  // Left at 2: genuinely ambiguous (e.g. "the system prompt for cooking
  // rice...") — raising it risks false positives on ordinary text.
  [2, /\bsystem\s+prompt\b/i],
  [3, /\b(?:enable|enter|activate)\s+(?:developer|debug|god|dan)\s+mode\b/i],
  [3, /\bjailbreak\b/i],
  [3, /\bpretend\s+(?:to\s+be|you(?:'| a)re|that\s+you)\b/i],
  // Left at 2: genuinely ambiguous (e.g. "act as a sounding board").
  [2, /\bact\s+as\s+(?:if\s+you|an?\s+)/i],
  [3, /\bdo\s+anything\s+now\b/i],
];

const EXFILTRATION_PATTERNS: Array<[number, RegExp]> = [
  [3, /\b(?:reveal|print|repeat|show|output|tell\s+me)\s+(?:your\s+|the\s+)?(?:system\s+prompt|initial\s+instructions?|prompt|guidelines?|rules?)\b/i],
  [3, /\bwhat\s+(?:are|were)\s+your\s+(?:original\s+|initial\s+|system\s+)?(?:instructions?|guidelines?|rules?|prompt)\b/i],
  [3, /\b(?:exfiltrate|leak|dump)\b.*\b(?:secret|token|key|credential|env|vault)\b/i],
  [2, /\bprint\s+(?:everything\s+)?(?:above|before\s+this)\b/i],
];

const CHAT_TEMPLATE_TOKENS: RegExp = /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?INST\]|<<\/?SYS>>|<\|eot_id\|>|<\|start_header_id\|>/i;
const ROLE_MARKER: RegExp = /(?:^|\n)\s*(?:system|assistant|developer|tool)\s*:/i;
const INVISIBLE_CHARS: RegExp = /[​-‏‪-‮⁠-⁤﻿­]/;
const UNICODE_TAG_CHARS: RegExp = /[\u{E0000}-\u{E007F}]/u;
const LARGE_BASE64: RegExp = /[A-Za-z0-9+/]{512,}={0,2}/;
const NEAR_SIZE_LIMIT = 9_000;

export function screenContent(text: string, metadata?: unknown): ContentScreenResult {
  const signals = new Set<ContentSignal>();
  let risk = 0;

  const metaStr = metadata === undefined ? '' : safeStringify(metadata).slice(0, 4_000);
  const haystack = metaStr ? `${text}\n${metaStr}` : text;

  // rev3-F2 sub-threshold accumulation: sum EVERY matching pattern's weight
  // rather than stopping at the first match. Several distinct phrasings that are
  // each individually below the escalation threshold are, together, more
  // suspicious than any one alone — capping at the first match let a message
  // stuffed with multiple borderline injection/exfiltration phrasings stay
  // sub-threshold and skip LLM escalation entirely.
  for (const [weight, re] of INJECTION_PATTERNS) {
    if (re.test(haystack)) { risk += weight; signals.add('injection_phrase'); }
  }
  for (const [weight, re] of EXFILTRATION_PATTERNS) {
    if (re.test(haystack)) { risk += weight; signals.add('exfiltration_phrase'); }
  }
  if (CHAT_TEMPLATE_TOKENS.test(haystack)) { risk += 3; signals.add('chat_template_token'); }
  if (ROLE_MARKER.test(haystack)) { risk += 1; signals.add('role_marker'); }
  if (INVISIBLE_CHARS.test(haystack)) { risk += 2; signals.add('invisible_chars'); }
  if (UNICODE_TAG_CHARS.test(haystack)) { risk += 4; signals.add('unicode_tag_chars'); }
  if (LARGE_BASE64.test(haystack)) { risk += 2; signals.add('large_base64_blob'); }
  if (text.length >= NEAR_SIZE_LIMIT) { risk += 1; signals.add('near_size_limit'); }

  return { risk, signals: [...signals] };
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return '';
  }
}
