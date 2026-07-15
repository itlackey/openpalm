import {
	acquireInstallLock,
	releaseInstallLock,
	type ControlPlaneState,
	type InstallLockHandle
} from '@openpalm/lib';
import { errorResponse } from './helpers.js';

const INSTALL_IN_PROGRESS_MESSAGE =
	"Another install or update is already running. Wait for it to finish, or run 'openpalm unlock' to clear a stale lock.";

/** Serialize rollback-protected admin mutations with lifecycle updates. */
export function withAdminUpdateLock(
	state: ControlPlaneState,
	requestId: string,
	run: (
		lock: InstallLockHandle,
		deferReleaseUntil: (work: Promise<unknown>) => void
	) => Response | Promise<Response>
): Promise<Response> {
	const lock = acquireInstallLock(state.dataDir);
	if (!lock) {
		return Promise.resolve(
			errorResponse(409, 'install_in_progress', INSTALL_IN_PROGRESS_MESSAGE, {}, requestId)
		);
	}

	return (async () => {
		const deferred = { work: null as Promise<unknown> | null };
		try {
			return await run(lock, (work) => {
				deferred.work = work;
			});
		} finally {
			if (deferred.work) {
				void deferred.work.then(
					() => releaseInstallLock(lock),
					() => releaseInstallLock(lock)
				);
			} else {
				releaseInstallLock(lock);
			}
		}
	})();
}
