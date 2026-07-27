import { patchSecretsEnvFile, randomHex } from '@openpalm/lib';
import { defineCommand } from 'citty';
import { defineAction } from '../lib/action.ts';
import { ensureValidState } from '../lib/cli-state.ts';

export default defineCommand({
	meta: {
		name: 'reset-password',
		description: 'Reset the OpenPalm UI login password'
	},
	args: {
		password: {
			type: 'string',
			description: 'Set an explicit password instead of generating a random one',
			required: false
		}
	},
	run: defineAction(async ({ args }) => {
		const newPassword = await runResetPasswordAction({
			password: typeof args.password === 'string' ? args.password : undefined
		});
		console.log('UI login password reset. New password:');
		console.log(newPassword);
		console.log('Takes effect immediately — no restart needed.');
	})
});

/**
 * C3: recovery path for a lost UI password, and the fix for the password
 * changing to wrongly require a restart. Writes the new value straight to
 * the secret file via the existing patchSecretsEnvFile/writeSecret path
 * (`op_ui_login_password`) — the SAME file `getUiLoginPassword()` now reads
 * live (mtime/size-cached) on every request, so this is a pure file write.
 * It must NOT trigger `docker compose restart` or any host-side UI process
 * restart: with the live-read fix in place, a restart is no longer needed,
 * and forcing one here would reintroduce the very downtime this command
 * exists to avoid.
 */
export async function runResetPasswordAction(options: { password?: string } = {}): Promise<string> {
	const state = ensureValidState();
	const password = options.password?.trim() || randomHex(16);
	patchSecretsEnvFile(state.homeDir, { OP_UI_LOGIN_PASSWORD: password });
	return password;
}
