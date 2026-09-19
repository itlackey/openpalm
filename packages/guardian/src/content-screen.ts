export type ContentSignal =
	| 'injection_phrase'
	| 'role_marker'
	| 'chat_template_token'
	| 'hidden_unicode'
	| 'encoded_blob'
	| 'exfiltration_phrase'
	| 'near_size_limit';

const INJECTION = [
	/\b(?:ignore|disregard|forget|override|bypass)\b.{0,50}\b(?:instructions?|rules?|prompt|context)\b/i,
	/\byou\s+are\s+now\b/i,
	/\b(?:developer|debug|god|dan)\s+mode\b/i,
	/\b(?:jailbreak|do\s+anything\s+now)\b/i,
	/\bnew\s+instructions?\s*:/i
] as const;

const EXFILTRATION = [
	/\b(?:reveal|print|repeat|show|output|dump)\b.{0,60}\b(?:system\s+prompt|instructions?|secret|token|credential|env)\b/i,
	/\bwhat\s+(?:are|were)\s+your\s+(?:original\s+|system\s+)?(?:instructions?|prompt|rules?)\b/i,
	/\b(?:exfiltrate|leak|dump)\b.{0,60}\b(?:secret|token|key|credential|env|vault)\b/i
] as const;

const CHAT_TOKENS =
	/<\|(?:im_start|im_end|system|user|assistant|endoftext|eot_id|start_header_id)\|>|\[\/?INST\]|<<\/?SYS>>/i;
const ROLE_MARKER = /(?:^|\n)\s*(?:system|assistant|developer|tool)\s*:/i;
const HIDDEN_UNICODE = /[​-‏‪-‮⁠-⁤﻿­\u{E0000}-\u{E007F}]/u;
const ENCODED_BLOB = /[A-Za-z0-9+/]{512,}={0,2}/;

export function screenContent(text: string): { risk: number; signals: ContentSignal[] } {
	const signals = new Set<ContentSignal>();
	let risk = 0;
	for (const pattern of INJECTION) {
		if (pattern.test(text)) {
			risk += 3;
			signals.add('injection_phrase');
		}
	}
	for (const pattern of EXFILTRATION) {
		if (pattern.test(text)) {
			risk += 3;
			signals.add('exfiltration_phrase');
		}
	}
	if (CHAT_TOKENS.test(text)) {
		risk += 3;
		signals.add('chat_template_token');
	}
	if (ROLE_MARKER.test(text)) {
		risk += 2;
		signals.add('role_marker');
	}
	if (HIDDEN_UNICODE.test(text)) {
		risk += 4;
		signals.add('hidden_unicode');
	}
	if (ENCODED_BLOB.test(text)) {
		risk += 2;
		signals.add('encoded_blob');
	}
	if (text.length >= 28_000) {
		risk += 1;
		signals.add('near_size_limit');
	}
	return { risk, signals: [...signals] };
}
