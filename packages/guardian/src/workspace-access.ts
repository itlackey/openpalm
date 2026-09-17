import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

import { workspacePath } from './workspace-policy.js';

export type WorkspaceTextFile = {
	text: string;
	mimeType: string;
	truncated: boolean;
};

export interface WorkspaceAccess {
	allows(path: string, signal: AbortSignal): Promise<boolean>;
	readText(path: string, maxBytes: number, signal: AbortSignal): Promise<WorkspaceTextFile>;
}

export class WorkspaceAccessError extends Error {
	constructor(
		message: string,
		readonly code: 'restricted' | 'not_found' | 'not_text' | 'unavailable'
	) {
		super(message);
		this.name = 'WorkspaceAccessError';
	}
}

function contained(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function mimeType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case '.json':
			return 'application/json';
		case '.jsonc':
			return 'application/jsonc';
		case '.md':
		case '.mdx':
			return 'text/markdown';
		case '.css':
			return 'text/css';
		case '.html':
			return 'text/html';
		case '.js':
		case '.jsx':
		case '.mjs':
		case '.cjs':
		case '.ts':
		case '.tsx':
		case '.mts':
		case '.cts':
			return 'text/javascript';
		case '.xml':
			return 'application/xml';
		case '.yaml':
		case '.yml':
			return 'application/yaml';
		default:
			return 'text/plain';
	}
}

function text(bytes: Uint8Array, allowIncompleteSuffix: boolean): string {
	if (bytes.includes(0)) throw new WorkspaceAccessError('Workspace file is not text.', 'not_text');
	const attempts = allowIncompleteSuffix ? 4 : 1;
	for (let trim = 0; trim < attempts && trim <= bytes.length; trim += 1) {
		try {
			return new TextDecoder('utf-8', { fatal: true }).decode(
				trim === 0 ? bytes : bytes.subarray(0, bytes.length - trim)
			);
		} catch {
			// A byte cap can split a valid UTF-8 code point. At most three bytes
			// need to be removed to recover the complete prefix.
		}
	}
	throw new WorkspaceAccessError('Workspace file is not UTF-8 text.', 'not_text');
}

async function canonicalRoot(root: string): Promise<string> {
	try {
		return await realpath(root);
	} catch {
		throw new WorkspaceAccessError('Workspace is unavailable.', 'unavailable');
	}
}

async function openContainedFile(root: string, path: string, signal: AbortSignal) {
	if (signal.aborted) throw signal.reason;
	const checked = workspacePath(path);
	if (!checked.ok) {
		throw new WorkspaceAccessError('Workspace path is restricted.', 'restricted');
	}
	const boundary = await canonicalRoot(root);
	let target: string;
	try {
		target = await realpath(resolve(boundary, checked.path));
	} catch {
		throw new WorkspaceAccessError('Workspace file was not found.', 'not_found');
	}
	if (!contained(boundary, target)) {
		throw new WorkspaceAccessError('Workspace path escapes its boundary.', 'restricted');
	}

	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
		const [descriptorPath, metadata] = await Promise.all([
			realpath(`/proc/self/fd/${handle.fd}`),
			handle.stat()
		]);
		if (!contained(boundary, descriptorPath) || !metadata.isFile()) {
			throw new WorkspaceAccessError('Workspace path is not a regular file.', 'restricted');
		}
		if (signal.aborted) throw signal.reason;
		return handle;
	} catch (error) {
		await handle?.close().catch(() => {});
		if (error instanceof WorkspaceAccessError) throw error;
		throw new WorkspaceAccessError('Workspace file cannot be opened safely.', 'unavailable');
	}
}

export function createWorkspaceAccess(root: string): WorkspaceAccess {
	return {
		async allows(path, signal) {
			try {
				const handle = await openContainedFile(root, path, signal);
				await handle.close();
				return true;
			} catch (error) {
				if (signal.aborted) throw signal.reason ?? error;
				return false;
			}
		},

		async readText(path, maxBytes, signal) {
			const handle = await openContainedFile(root, path, signal);
			try {
				const buffer = Buffer.alloc(maxBytes + 1);
				let offset = 0;
				while (offset < buffer.length) {
					if (signal.aborted) throw signal.reason;
					const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
					if (bytesRead === 0) break;
					offset += bytesRead;
				}
				const truncated = offset > maxBytes;
				return {
					text: text(buffer.subarray(0, Math.min(offset, maxBytes)), truncated),
					mimeType: mimeType(path),
					truncated
				};
			} finally {
				await handle.close();
			}
		}
	};
}
