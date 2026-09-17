const MAX_PATH_LENGTH = 1_024;
const MAX_QUERY_LENGTH = 500;
const DENIED_COMPONENTS = new Set([
	'.git',
	'.ssh',
	'.aws',
	'.azure',
	'.config',
	'.gnupg',
	'.private',
	'.secrets',
	'credentials',
	'secrets'
]);
const DENIED_FILENAMES = new Set([
	'auth.json',
	'credentials.json',
	'id_rsa',
	'id_ed25519',
	'npmrc',
	'pypirc'
]);

export type WorkspacePathResult =
	| { ok: true; path: string }
	| { ok: false; error: 'invalid_path' | 'restricted_path' };

function secretLike(component: string): boolean {
	const lower = component.toLowerCase();
	if (DENIED_COMPONENTS.has(lower) || DENIED_FILENAMES.has(lower)) return true;
	if (lower === '.env.example') return false;
	if (lower === '.env' || lower.startsWith('.env.')) return true;
	if (lower.endsWith('.pem') || lower.endsWith('.key') || lower.endsWith('.p12')) return true;
	return /(^|[-_.])(credential|secret|token|password)(s)?($|[-_.])/.test(lower);
}

export function workspacePath(value: string, allowRoot = false): WorkspacePathResult {
	const path = value.trim();
	if (
		path.length > MAX_PATH_LENGTH ||
		path.includes('\0') ||
		path.includes('\\') ||
		path.startsWith('/') ||
		/^[A-Za-z]:/.test(path)
	) {
		return { ok: false, error: 'invalid_path' };
	}
	const components = path.split('/');
	if (components.some((part) => !part || part === '.' || part === '..')) {
		if (allowRoot && path === '') return { ok: true, path: '' };
		return { ok: false, error: 'invalid_path' };
	}
	if (components.some(secretLike)) return { ok: false, error: 'restricted_path' };
	return { ok: true, path };
}

export function workspaceQuery(value: string): string | null {
	const query = value.trim();
	if (!query || query.length > MAX_QUERY_LENGTH || query.includes('\0')) return null;
	return query;
}

export function filterWorkspacePaths(paths: readonly string[], limit: number): string[] {
	const accepted: string[] = [];
	for (const path of paths) {
		const checked = workspacePath(path);
		if (checked.ok) accepted.push(checked.path);
		if (accepted.length >= limit) break;
	}
	return accepted;
}
