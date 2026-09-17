import { Database } from 'bun:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const MAX_HANDLE_LENGTH = 2_048;
const MAX_KEY_LENGTH = 512;

export class ConversationStore {
	private readonly database: Database;

	constructor(path = Bun.env.PORTAL_STATE_PATH ?? '/var/lib/openpalm/portal.db') {
		mkdirSync(dirname(path), { recursive: true });
		this.database = new Database(path, { create: true, strict: true });
		this.database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
		this.database.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        adapter TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        handle TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (adapter, conversation_key)
      ) STRICT;
    `);
	}

	get(adapter: string, key: string): string | undefined {
		if (!key || key.length > MAX_KEY_LENGTH) return undefined;
		const row = this.database
			.query('SELECT handle FROM conversations WHERE adapter = ? AND conversation_key = ?')
			.get(adapter, key) as { handle: string } | null;
		return row && typeof row.handle === 'string' && row.handle.length <= MAX_HANDLE_LENGTH
			? row.handle
			: undefined;
	}

	set(adapter: string, key: string, handle: string): void {
		if (!key || key.length > MAX_KEY_LENGTH) throw new Error('invalid conversation key');
		if (!handle || handle.length > MAX_HANDLE_LENGTH)
			throw new Error('invalid conversation handle');
		this.database
			.query(`
      INSERT INTO conversations (adapter, conversation_key, handle, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(adapter, conversation_key) DO UPDATE SET
        handle = excluded.handle,
        updated_at = excluded.updated_at
    `)
			.run(adapter, key, handle, Date.now());
	}

	clear(adapter: string, key: string): void {
		this.database
			.query('DELETE FROM conversations WHERE adapter = ? AND conversation_key = ?')
			.run(adapter, key);
	}

	close(): void {
		this.database.close();
	}
}
