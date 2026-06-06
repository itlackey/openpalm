// UI-state shapes for the three AKM profile kinds. Shared by the AkmTab
// orchestrator (which owns the arrays + load/save), the list sections, and the
// edit drawers so the bindable props line up without redeclaring the shapes.
// Plain types — no class, no barrel.
import type { FEntry, Tri, ProcKey } from './improve-process-helpers';

export interface LlmProfile {
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
	judgeModel: string;
	supportsJsonSchema: boolean;
	enableThinking: boolean;
	structuredOutput: boolean; // capabilities.structuredOutput
	extraParams: string; // JSON text; '' = unset
}

export interface AgentProfile {
	id: string;
	name: string;
	platform: 'opencode' | 'claude' | 'opencode-sdk';
	bin: string;
	args: string;
	workspace: string;
	model: string;
}

export interface ImproveProfile {
	id: string;
	name: string;
	description: string;
	limit: number;
	autoAccept: number;
	processes: Record<ProcKey, FEntry>;
	// profile-level git sync (akm ImproveProfileConfigSchema.sync)
	syncEnabled: Tri;
	syncPush: Tri;
	syncMessage: string;
}
