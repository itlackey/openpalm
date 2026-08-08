// UI-state shapes for the AKM engine/strategy kinds (akm 0.9 schema). Shared by
// the AkmTab orchestrator (which owns the arrays + load/save), the list
// sections, and the edit drawers so the bindable props line up without
// redeclaring the shapes. Plain types — no class, no barrel.
//
// akm 0.9: LLM and agent engines live in ONE config map (`engines.<name>`),
// partitioned by `kind` ("llm" | "agent"); improve strategies live under
// `improve.strategies.<name>`.
import type { FEntry, Tri, ProcKey } from './improve-process-helpers';

// Full akm 0.9 agent platform enum.
export const AGENT_PLATFORMS = [
	'opencode',
	'claude',
	'opencode-sdk',
	'codex',
	'copilot',
	'pi',
	'gemini',
	'aider',
	'amazonq',
	'openhands',
] as const;
export type AgentPlatform = (typeof AGENT_PLATFORMS)[number];

export interface LlmEngine {
	id: string;
	name: string;
	endpoint: string;
	model: string;
	provider: string;
	apiKey: string;
	showApiKey: boolean;
	temperature: string;
	maxTokens: string;
	timeoutMs: string;
	concurrency: string;
	contextLength: string;
	supportsJsonSchema: boolean;
	enableThinking: boolean;
	extraParams: string; // JSON text; '' = unset
}

export interface AgentEngine {
	id: string;
	name: string;
	platform: AgentPlatform;
	bin: string;
	args: string;
	workspace: string;
	model: string;
	timeoutMs: string;
	llmEngine: string; // only valid when platform === 'opencode-sdk'
}

export interface ImproveStrategy {
	id: string;
	name: string;
	description: string;
	limit: number;
	processes: Record<ProcKey, FEntry>;
	// strategy-level git sync (akm improve strategy sync block)
	syncEnabled: Tri;
	syncPush: Tri;
	syncMessage: string;
}
