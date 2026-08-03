const TASK_FILE_SUFFIX = '.yml';
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TASK_ID_YAML_SUFFIX_RE = /\.ya?ml$/i;
const WINDOWS_RESERVED_DEVICE_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu;
const TASK_REVISION_RE = /^sha256:[0-9a-f]{64}$/;
const UNICODE_FORMAT_CONTROL_RE = /\p{Cf}/u;

export const TASK_CONTENT_MAX_BYTES = 256 * 1024;
export const TASK_FILE_MAX_VISIBLE = 1_000;
export const TASK_ID_MAX_LENGTH = 228;
export const AUTOMATION_LOG_MAX_CANDIDATE_FILES = 1_000;
export const AUTOMATION_LOG_MAX_AGGREGATE_READ_BYTES = 4 * 1024 * 1024;
export const AUTOMATION_LOG_MAX_FILE_READ_BYTES = 1024 * 1024;
export const AUTOMATION_LOG_MAX_RESPONSE_BYTES = 1024 * 1024;
export const AUTOMATION_RUNTIME_MAX_DIRECTORY_ENTRIES = 2_000;
export const AUTOMATION_RUNTIME_MAX_STDIN_BYTES = 2 * 1024 * 1024;
export const AUTOMATION_RUNTIME_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
export const AUTOMATION_RUNTIME_SHAPE = 'openpalm-automation-runtime';
export const AUTOMATION_RUNTIME_SCHEMA_VERSION = 1;

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function isWellFormedUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function hasInvalidPortableFilenameCharacter(name: string): boolean {
	for (const character of name) {
		const codePoint = character.codePointAt(0) ?? 0;
		if (codePoint <= 0x1f || codePoint === 0x7f || '<>:"|?*'.includes(character)) return true;
	}
	return false;
}

export function portableTaskFilenameError(name: string): string | null {
	if (!isWellFormedUnicode(name)) return 'Task file name must be well-formed Unicode';
	if (!name.endsWith(TASK_FILE_SUFFIX)) return 'Task file name must end in exact lowercase .yml';
	if (name !== name.trim()) return 'Task file name must not start or end with whitespace';
	if (name.includes('/') || name.includes('\\')) return 'Task file name must be a basename';
	if (name.length > 255 || utf8ByteLength(name) > 255) {
		return 'Task file name must be at most 255 bytes';
	}
	if (UNICODE_FORMAT_CONTROL_RE.test(name)) {
		return 'Task file name must not contain Unicode format or bidirectional control characters';
	}
	if (hasInvalidPortableFilenameCharacter(name)) {
		return 'Task file name contains characters that are unsafe on supported hosts';
	}
	const taskId = name.slice(0, -TASK_FILE_SUFFIX.length);
	if (WINDOWS_RESERVED_DEVICE_RE.test(taskId)) {
		return 'Task file name uses a reserved Windows device name';
	}
	return null;
}

export function schedulableTaskIdError(taskId: string): string | null {
	if (!TASK_ID_RE.test(taskId)) {
		return 'Task ID must start with a letter or digit and use only letters, digits, dots, underscores, and dashes';
	}
	if (taskId.length > TASK_ID_MAX_LENGTH) {
		return `Task ID must be at most ${TASK_ID_MAX_LENGTH} characters`;
	}
	if (TASK_ID_YAML_SUFFIX_RE.test(taskId)) {
		return 'Task ID must not end in .yml or .yaml';
	}
	if (WINDOWS_RESERVED_DEVICE_RE.test(taskId)) {
		return 'Task ID uses a reserved Windows device name';
	}
	return null;
}

export function schedulableTaskFilenameError(name: string): string | null {
	return portableTaskFilenameError(name) ?? schedulableTaskIdError(taskIdFromTaskFilename(name));
}

export function assertPortableTaskFilename(name: string): void {
	const error = portableTaskFilenameError(name);
	if (error !== null) throw new Error(`Invalid task file name: ${name} (${error})`);
}

export function assertSchedulableTaskFilename(name: string): void {
	const error = schedulableTaskFilenameError(name);
	if (error !== null) throw new Error(`Invalid schedulable task file name: ${name} (${error})`);
}

export function taskIdFromTaskFilename(name: string): string {
	assertPortableTaskFilename(name);
	return name.slice(0, -TASK_FILE_SUFFIX.length);
}

export function isSchedulableTaskFilename(name: string): boolean {
	return schedulableTaskFilenameError(name) === null;
}

export function assertTaskRevision(revision: string): void {
	if (!TASK_REVISION_RE.test(revision)) throw new Error('Invalid task file revision');
}

export type TaskFileSnapshot = {
	content: string;
	revision: string;
};

export type AutomationTaskFileInfo = {
	fileName: string;
	taskId: string;
	size: number;
	revision: string;
	schedulable: boolean;
};

export type AutomationRuntimeOperation = 'list' | 'read' | 'write' | 'delete' | 'logs';

type AutomationRuntimeRequestBase = {
	shape: typeof AUTOMATION_RUNTIME_SHAPE;
	schemaVersion: typeof AUTOMATION_RUNTIME_SCHEMA_VERSION;
};

export type AutomationRuntimeRequest = AutomationRuntimeRequestBase &
	(
		| { operation: 'list' }
		| { operation: 'read'; fileName: string }
		| {
				operation: 'write';
				fileName: string;
				content: string;
				expectedRevision: string | null;
		  }
		| { operation: 'delete'; fileName: string; expectedRevision: string }
		| { operation: 'logs'; fileName: string; limit: number }
	);

export type AutomationRuntimeResult =
	| { operation: 'list'; files: AutomationTaskFileInfo[] }
	| ({ operation: 'read'; fileName: string } & TaskFileSnapshot)
	| { operation: 'write'; fileName: string; revision: string }
	| { operation: 'delete'; fileName: string }
	| { operation: 'logs'; fileName: string; lines: string[] };

export type AutomationRuntimeErrorCode =
	| 'busy'
	| 'conflict'
	| 'invalid_name'
	| 'invalid_request'
	| 'invalid_response'
	| 'invalid_task_id'
	| 'io_error'
	| 'not_found'
	| 'too_large'
	| 'unavailable'
	| 'unsafe_file';

export type AutomationRuntimeEnvelope =
	| {
			shape: typeof AUTOMATION_RUNTIME_SHAPE;
			schemaVersion: typeof AUTOMATION_RUNTIME_SCHEMA_VERSION;
			ok: true;
			result: AutomationRuntimeResult;
	  }
	| {
			shape: typeof AUTOMATION_RUNTIME_SHAPE;
			schemaVersion: typeof AUTOMATION_RUNTIME_SCHEMA_VERSION;
			ok: false;
			error: { code: AutomationRuntimeErrorCode; message: string };
	  };
