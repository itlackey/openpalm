import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function retainAdminE2eHome(environment, homeDirectory) {
	if (
		environment.OPENPALM_ADMIN_E2E_HOME ||
		environment.OPENPALM_ADMIN_E2E_PROVIDER ||
		environment.OPENPALM_ADMIN_E2E_PROVIDER_KEY ||
		environment.OPENPALM_ADMIN_E2E_PROVIDER_KEY_FILE ||
		environment.OPENPALM_ADMIN_E2E_KEEP_HOME === 'true' ||
		environment.OPENPALM_ADMIN_E2E_KEEP_RUNNING === 'true'
	)
		return true;
	if (!homeDirectory) return false;
	const authFile = join(homeDirectory, 'knowledge', 'secrets', 'auth.json');
	try {
		const metadata = lstatSync(authFile);
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) return true;
		const auth = JSON.parse(readFileSync(authFile, 'utf8'));
		return !auth || typeof auth !== 'object' || Array.isArray(auth) || Object.keys(auth).length > 0;
	} catch (error) {
		// Unreadable or malformed authentication is never safe to discard.
		return error?.code !== 'ENOENT';
	}
}
