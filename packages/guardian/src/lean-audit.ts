import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createLogger } from './logger.js';

const log = createLogger('guardian:audit');
let prepared = false;

export function audit(event: Record<string, unknown>): void {
	const path = Bun.env.GUARDIAN_AUDIT_PATH ?? '/opt/openpalm/logs/guardian-audit.log';
	try {
		if (!prepared) {
			mkdirSync(dirname(path), { recursive: true });
			prepared = true;
		}
		appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, {
			encoding: 'utf8',
			mode: 0o600
		});
	} catch (error) {
		log.error('audit_write_failed', {
			error: error instanceof Error ? error.message : String(error)
		});
	}
}
