#!/usr/bin/env node
// One-time, source-side transition tooling. Not shipped with fhold.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
	appendFileSync,
	chmodSync,
	copyFileSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	readdirSync,
	realpathSync,
	writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareNativeHistory } from './prepare-native-history.mjs';

const HELP = `One-time OpenPalm → fhold migration (Linux, Node 22+)

node scripts/migrate-to-fhold.mjs --from /old/home --to /new/home --name april \\
  --fhold /path/to/released/fhold-cli --source-image openpalm/assistant:<version> \\
  --backup /new/private/migration-directory [options]

Preview is the default. Stop only the inventoried source services before --apply.
Retain their containers for external-mount/volume inventory; see the migration guide.
  --apply                     Make the cold backup, install and transfer; do not start
  --include-provider-auth     Copy native provider auth and referenced secret files
  --include-user-env          Copy knowledge/env/user.env
  --include-native-accounts   Copy container-owned Claude/Codex accounts and history
  --native-path <relative>    Additional path below the source Assistant home; repeatable
  --source-config <file>      Reviewed lean intent for a legacy 0.13 source
  --runtime <directory>       Explicit resolved OpenCode data directory for linked runtime
  --directory-map <file>      Reviewed old-directory → /work mapping
  --archive-interrupted      Preserve unfinished tool calls as interrupted history
  --help                      Show this help

The destination and backup directory must not exist. Existing homes are never
overwritten. Source services are never started, stopped or changed by this script.
OpenPalm 0.13 requires --source-config and --runtime; legacy settings are never inferred.
Physical external bind sources and named volumes are privately archived, not activated.
`;

function object(value, label) {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error(`${label} must be an object.`);
	return value;
}

function inside(root, path) {
	const rel = relative(root, path);
	return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function hasControls(value) {
	return [...value].some(
		(character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
	);
}

function safePath(root, rel, missing = false) {
	if (
		typeof rel !== 'string' ||
		!rel ||
		isAbsolute(rel) ||
		rel.includes('\\') ||
		hasControls(rel) ||
		rel.split('/').some((part) => !part || part === '.' || part === '..')
	)
		throw new Error('Unsafe relative path.');
	let path = root;
	for (const part of rel.split('/')) {
		path = join(path, part);
		if (missing && !existsSync(path)) continue;
		if (lstatSync(path).isSymbolicLink()) throw new Error(`Review linked data separately: ${rel}`);
	}
	return path;
}

function canonical(path) {
	const full = resolve(path);
	let parent = full;
	while (!existsSync(parent)) parent = dirname(parent);
	return resolve(realpathSync(parent), relative(parent, full));
}

function json(path) {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576)
		throw new Error(`Expected a regular JSON file under 1 MiB: ${path}`);
	try {
		return object(JSON.parse(readFileSync(path, 'utf8')), path);
	} catch {
		throw new Error(`Invalid JSON object: ${path} (values were not logged).`);
	}
}

function digest(path) {
	const hash = createHash('sha256');
	const fd = openSync(path, 'r');
	const buffer = Buffer.alloc(1024 * 1024);
	try {
		let count;
		while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0)
			hash.update(buffer.subarray(0, count));
		return hash.digest('hex');
	} finally { closeSync(fd); }
}

export function runCommand(command, args, env = {}, diagnostics) {
	const child = spawnSync(command, args, {
		env: { ...process.env, ...env },
		encoding: 'utf8',
		maxBuffer: 32 * 1024 * 1024
	});
	if (diagnostics)
		appendFileSync(
			diagnostics,
			`${JSON.stringify({
				command,
				args,
				status: child.status,
				stdout: child.stdout,
				stderr: child.stderr,
				error: child.error?.message
			})}\n`,
			{ mode: 0o600 }
		);
	// Native tools can print credentials and configuration in errors. Keep their
	// full diagnostics private, not in a terminal transcript or public report.
	if (child.error || child.status !== 0)
		throw new Error(`${command} ${args[0] ?? ''} failed; no child output was logged.`);
	return child.stdout.trim();
}

function sourceContainers(home, run) {
	const ids = run('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project'])
		.split(/\s+/)
		.filter(Boolean);
	if (!ids.length) return [];
	return JSON.parse(run('docker', ['inspect', ...ids]))
		.filter((c) => {
			const working = c.Config?.Labels?.['com.docker.compose.project.working_dir'];
			return working && canonical(working) === join(home, 'system', 'stack');
		})
		.map((c) => ({
			id: c.Id,
			name: c.Name.replace(/^\//, ''),
			running: c.State.Running,
			image: c.Image,
			mounts: c.Mounts.map((m) => ({ type: m.Type, source: m.Source, name: m.Name, destination: m.Destination }))
		}));
}

function installConfig(source, name, version) {
	const a = object(source.assistant, 'source assistant settings');
	const g = object(source.gateway, 'source gateway settings');
	return {
		product: 'fhold',
		version: 1,
		deployment: {
			projectName: name,
			imageNamespace: 'fwdslsh',
			images: { assistant: version, guardian: version, portal: version }
		},
		assistant: {
			bindAddress: a.bindAddress,
			port: a.port,
			timezone: a.timezone,
			automaticMemory: a.automaticMemory,
			// First boot must not silently pair cloned accounts. Use native guided
			// setup after verifying the migration; preserve the source choices below.
			codexRemote: false,
			codexSandbox: a.codexSandbox ?? 'workspace-write',
			claudeRemote: false
		},
		gateway: { enabled: false, bindAddress: g.bindAddress, port: g.port },
		credentials: {
			owner: { id: 'owner', policy: 'full' },
			discord: { id: 'discord', policy: 'chat' },
			slack: { id: 'slack', policy: 'chat' }
		},
		portals: {
			discord: {
				enabled: false,
				credential: 'discord',
				access: { guilds: [], roles: [], users: [], blockedUsers: [] }
			},
			slack: {
				enabled: false,
				credential: 'slack',
				access: { channels: [], users: [], blockedUsers: [] }
			}
		}
	};
}

export function planMigration(options, run = runCommand) {
	if (process.platform !== 'linux') throw new Error('This transition utility supports Linux only.');
	for (const key of ['from', 'to', 'name', 'fhold', 'source-image', 'backup']) {
		if (!options[key]) throw new Error(`Missing --${key}.`);
	}
	if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(options.name))
		throw new Error('Choose a lowercase DNS-safe instance name.');
	const source = canonical(options.from),
		target = canonical(options.to),
		backup = canonical(options.backup);
	if (!lstatSync(source).isDirectory())
		throw new Error('Source must be an existing home directory.');
	if (existsSync(target) || existsSync(backup))
		throw new Error('Use new, nonexistent destination and backup directories.');
	if (
		[source, target, backup].some((p) => p === '/') ||
		inside(source, target) ||
		inside(target, source) ||
		inside(source, backup) ||
		inside(backup, source) ||
		inside(target, backup) ||
		inside(backup, target)
	)
		throw new Error(
			'Source, destination and private backup must be separate, non-nested directories.'
		);
	const configPath = safePath(source, 'state/stack.json', true);
	const legacy = !existsSync(configPath) && existsSync(safePath(source, 'system/stack/core.compose.yml', true));
	if (legacy && (!options['source-config'] || !options.runtime))
		throw new Error('OpenPalm 0.13 requires an explicit reviewed --source-config and resolved --runtime.');
	const sourceConfig = json(legacy ? canonical(options['source-config']) : configPath);
	if (sourceConfig.version !== 1 || sourceConfig.product ||
		(!legacy && !existsSync(safePath(source, 'system/stack/stack.compose.yml')))) {
		throw new Error(
			'Select an OpenPalm home with validated lean intent; older homes require --source-config and --runtime.'
		);
	}
	const cli = canonical(options.fhold);
	if (!lstatSync(cli).isFile()) throw new Error('--fhold must name a packaged CLI executable.');
	const version = run(cli, ['--version']);
	if (!/^\d+\.\d+\.\d{10}-(?:alpha|beta|rc)(?:\.[1-9]\d*)?$|^\d+\.\d+\.\d{10}$/.test(version))
		throw new Error('Expected a timestamp-versioned fhold CLI.');
	if (
		options['archive-interrupted'] &&
		!run(cli, ['help', 'history']).includes('--archive-interrupted')
	)
		throw new Error(
			'This CLI does not support interrupted history archival; use alpha.2 or later.'
		);
	const sourceImage = options['source-image'];
	if (typeof sourceImage !== 'string' || sourceImage.startsWith('-') || /\s/.test(sourceImage))
		throw new Error('Select the exact trusted source Assistant image.');
	const sourceImageId = run('docker', ['image', 'inspect', '--format', '{{.Id}}', sourceImage]);
	const targetImage = `fwdslsh/fhold-assistant:${version}`;
	const targetImageId = run('docker', ['image', 'inspect', '--format', '{{.Id}}', targetImage]);
	for (const service of ['guardian', 'portal'])
		run('docker', ['image', 'inspect', '--format', '{{.Id}}', `fwdslsh/fhold-${service}:${version}`]);
	const containers = sourceContainers(source, run);
	const assistant = containers.find((c) =>
		c.mounts.some((m) => m.destination === '/home/opencode')
	);
	if (legacy && !assistant)
		throw new Error('Keep the legacy source Assistant container stopped, not removed, so external mount and named-volume inventory can be preserved.');
	if (assistant && assistant.image !== sourceImageId)
		throw new Error('--source-image does not match the source Assistant.');
	const externalMounts = [...new Map(containers.flatMap((c) =>
		c.mounts.filter(
			(m) => m.type === 'volume' || (m.source && !inside(source, canonical(m.source)))
		)
	).map((m) => {
		if (m.type === 'volume') {
			if (typeof m.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(m.name))
				throw new Error('Source named volume has no safe Docker volume identity.');
			return [`volume:${m.name}`, { ...m }];
		}
		if (m.type !== 'bind') throw new Error('Review unsupported external mount type.');
		const physical = canonical(m.source);
		return [`bind:${physical}`, { ...m, physical, directory: lstatSync(physical).isDirectory() }];
	})).values()];
	const nativeHome = assistant
		? canonical(assistant.mounts.find((m) => m.destination === '/home/opencode').source)
		: canonical(join(source, 'data/assistant'));
	const runtime = options.runtime ? canonical(options.runtime) : undefined;
	if (runtime && runtime !== join(nativeHome, '.local/share/opencode'))
		throw new Error('--runtime must name the selected source Assistant\'s resolved OpenCode data directory.');
	// A normal source shutdown can remove its containers. The selected native
	// home's canonical target still needs a cold archive when it is external;
	// never assume that archiving the home also follows its data symlink.
	if (!inside(source, nativeHome) && !externalMounts.some((m) => m.physical === nativeHome))
		externalMounts.push({ type: 'bind', source: nativeHome, physical: nativeHome,
			destination: '/home/opencode', directory: true });
	const suppliedDirectories = options['directory-map'] ? json(canonical(options['directory-map'])) : null;
	if (suppliedDirectories)
		for (const [from, to] of Object.entries(suppliedDirectories)) {
			if (!from.startsWith('/') || hasControls(from) || typeof to !== 'string' ||
				(to !== '/work' && !to.startsWith('/work/')) || hasControls(to) || to.includes('\\') ||
				to.split('/').some((part, index) => index > 0 && (!part || part === '.' || part === '..')))
				throw new Error('Unsafe history directory map; every target must be /work or a contained subdirectory.');
		}
	const config = installConfig(sourceConfig, options.name, version);
	const files = [],
		omitted = [],
		directories = [];
	function file(rel, dest = rel, root = source) {
		const path = safePath(root, rel);
		const stat = lstatSync(path);
		if (!stat.isFile()) throw new Error(`Not a regular file: ${rel}`);
		// Hash in bounded chunks and copy with the native filesystem primitive.
		// Authored Git packs and other regular files need not fit in memory.
		files.push({
			root,
			from: rel,
			to: dest,
			bytes: stat.size,
			sha256: digest(path),
			mode: stat.mode & 0o111 ? 0o700 : 0o600
		});
	}
	function tree(rel, dest = rel, native = false, root = source) {
		const path = safePath(root, rel, true);
		if (!existsSync(path)) return;
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) throw new Error(`Review linked data separately: ${rel}`);
		if (stat.isFile()) {
			file(rel, dest, root);
			return;
		}
		if (!stat.isDirectory()) {
			omitted.push(rel);
			return;
		}
		directories.push(dest);
		for (const name of readdirSync(path).sort()) {
			if (
				name === 'node_modules' ||
				(native &&
					(name.endsWith('-shm') || /\.(lock|pid|sock)$/.test(name) || name.includes('.tmp.')))
			) {
				omitted.push(join(rel, name));
				continue;
			}
			tree(join(rel, name), join(dest, name), native, root);
		}
	}
	for (const name of readdirSync(safePath(source, 'knowledge'))) {
		if (
			[
				'env',
				'secrets',
				'tasks',
				'imported-tasks',
				'disabled-tasks',
				'.git',
				'.akm',
				'node_modules'
			].includes(name)
		)
			continue;
		tree(`knowledge/${name}`);
	}
	tree('workspace');
	for (const name of ['persona.md', 'user-profile.md'])
		if (existsSync(safePath(source, `config/assistant/${name}`, true)))
			file(`config/assistant/${name}`);
	for (const root of ['tasks', 'imported-tasks', 'disabled-tasks']) {
		const path = safePath(source, `knowledge/${root}`, true);
		if (!existsSync(path)) continue;
		for (const name of readdirSync(path)) {
			if (/\.ya?ml$/.test(name) && lstatSync(join(path, name)).isFile())
				file(`knowledge/${root}/${name}`, `knowledge/imported-tasks/${name}`);
			else omitted.push(`knowledge/${root}/${name}`);
		}
	}
	const providerPath = safePath(source, 'config/assistant/opencode.json', true);
	if (existsSync(providerPath)) {
		const provider = json(providerPath);
		if (
			Object.keys(provider).some(
				(k) => !['$schema', 'model', 'small_model', 'provider'].includes(k)
			)
		)
			throw new Error(
				'Review native configuration manually: it contains executable/custom settings.'
			);
		const visit = (v) => {
			if (typeof v === 'string' && /\{env:/.test(v)) {
				const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(v);
				if (
					!match ||
					/^(?:OP_|FH_|OPENCODE_|AKM_|CODEX_|CLAUDE_|GUARDIAN_|PORTAL_|DISCORD_|SLACK_|LD_|HOME$|PATH$|NODE_OPTIONS$|BUN_)/.test(
						match[1]
					)
				)
					throw new Error('Review provider runtime environment references manually.');
				if (!options['include-user-env'])
					throw new Error(
						'Provider environment references require --include-user-env and a reviewed user.env.'
					);
			} else if (typeof v === 'string' && /\{file:/.test(v)) {
				const match = /^\{file:\/stash\/secrets\/([^{}]+)\}$/.exec(v);
				if (!match) throw new Error('Review unsupported provider file references manually.');
				if (!options['include-provider-auth'])
					throw new Error(
						'Provider settings need --include-provider-auth for private file references.'
					);
				file(`knowledge/secrets/${match[1]}`);
			} else if (v && typeof v === 'object') {
				// OpenCode documents this built-in SDK for ordinary custom/local
				// OpenAI-compatible endpoints. Preserve it, not arbitrary packages.
				if (Object.hasOwn(v, 'npm') && v.npm !== '@ai-sdk/openai-compatible')
					throw new Error('Review nonstandard provider SDK overrides manually.');
				for (const [key, value] of Object.entries(v)) {
					if (
						/^(api[_-]?key|authorization|token|secret|password)$/i.test(key) &&
						typeof value === 'string' &&
						value &&
						!/^\{(?:env|file):/.test(value) &&
						!options['include-provider-auth']
					)
						throw new Error('Inline provider credentials require --include-provider-auth.');
					visit(value);
				}
			}
		};
		visit(provider);
		file('config/assistant/opencode.json');
	}
	if (
		options['include-provider-auth'] &&
		existsSync(safePath(source, 'knowledge/secrets/auth.json', true))
	)
		file('knowledge/secrets/auth.json');
	if (options['include-user-env'] && existsSync(safePath(source, 'knowledge/env/user.env', true)))
		file('knowledge/env/user.env');
	if (options['include-native-accounts']) {
		for (const rel of ['.claude', '.claude.json', '.codex'])
			tree(rel, `data/assistant/${rel}`, true, nativeHome);
	}
	for (const rel of options['native-path'] ?? []) {
		safePath(nativeHome, rel);
		if (['.cache', '.bun', '.npm'].includes(rel.split('/')[0]) || rel === '.config' ||
			(rel.startsWith('.config/') && !['.config/gh', '.config/configstore'].includes(rel)) ||
			(rel.split('/')[0] === '.local' && !['.local/share/opencode/tool-output', '.local/share/opencode/snapshot'].includes(rel)))
			throw new Error(
				'Do not copy generated OpenCode/tool runtime trees; use native history recovery.'
			);
		tree(rel, `data/assistant/${rel}`, true, nativeHome);
	}
	const unique = new Map();
	for (const entry of files) {
		const previous = unique.get(entry.to);
		if (previous && previous.sha256 !== entry.sha256)
			throw new Error(`Conflicting staged files: ${entry.to}`);
		unique.set(entry.to, entry);
	}
	const maps = {};
	for (const portal of ['discord', 'slack']) {
		const path = safePath(source, `config/portal/${portal}/credentials.json`, true);
		maps[portal] = existsSync(path) ? json(path) : { version: 1, users: {} };
		if (maps[portal].version !== 1) throw new Error(`Unsupported ${portal} map.`);
		for (const username of Object.values(object(maps[portal].users, 'portal users'))) {
			if (!Object.hasOwn(sourceConfig.credentials, username))
				throw new Error(`Unknown mapped credential in ${portal}.`);
		}
	}
	for (const [username, value] of Object.entries(object(sourceConfig.credentials, 'credentials'))) {
		if (
			!/^[a-z][a-z0-9._-]{0,63}$/.test(username) ||
			['constructor', 'prototype'].includes(username) ||
			!['chat', 'read', 'full'].includes(value.policy)
		)
			throw new Error('Unsupported source credential.');
	}
	for (const portal of ['discord', 'slack']) {
		const settings = object(sourceConfig.portals[portal], `${portal} settings`);
		if (!Object.hasOwn(sourceConfig.credentials, settings.credential))
			throw new Error(`Unknown ${portal} default credential.`);
		for (const values of Object.values(object(settings.access, `${portal} access`))) {
			if (
				!Array.isArray(values) ||
				values.some((id) => typeof id !== 'string' || id.includes(',') || hasControls(id))
			)
				throw new Error(`Unsupported ${portal} allowlist.`);
		}
		if (settings.enabled) {
			safePath(source, `state/secrets/${portal}_bot_token`);
			if (portal === 'slack') safePath(source, 'state/secrets/slack_app_token');
		}
	}
	return {
		source,
		target,
		backup,
		cli,
		version,
		sourceImage,
		sourceImageId,
		targetImage,
		targetImageId,
		config,
		sourceConfig,
		maps,
		containers,
		externalMounts,
		legacy,
		runtime,
		suppliedDirectories,
		files: [...unique.values()],
		directories,
		omitted,
		nativeAccounts: options['include-native-accounts'] === true,
		archiveInterrupted: options['archive-interrupted'] === true
	};
}

export function applyMigration(plan, run = runCommand) {
	if (existsSync(plan.target) || existsSync(plan.backup))
		throw new Error('Destination/backup appeared since review. No existing data was overwritten.');
	if (sourceContainers(plan.source, run).some((c) => c.running))
		throw new Error('Stop the source instance using its own CLI, then retry. Nothing was written.');
	process.umask(0o077);
	mkdirSync(plan.backup, { recursive: true, mode: 0o700 });
	if (run === runCommand)
		run = (command, args, env) =>
			runCommand(command, args, env, join(plan.backup, 'commands.jsonl'));
	const write = (name, value) =>
		writeFileSync(join(plan.backup, name), `${JSON.stringify(value, null, 2)}\n`, {
			flag: 'wx',
			mode: 0o600
		});
	write('migration-plan.json', plan);
	// Cold rollback archive contains all source state, not merely selected files.
	run('tar', [
		'--create',
		'--sparse',
		'--file',
		join(plan.backup, 'source-home.tar'),
		'--directory',
		plan.source,
		'.'
	]);
	run('tar', [
		'--compare',
		'--file',
		join(plan.backup, 'source-home.tar'),
		'--directory',
		plan.source
	]);
	// Docker resolves volume identities without giving the host utility access to
	// Docker's private storage directory. Archive only the inventoried source;
	// never follow every home symlink or mount an unrelated parent tree.
	for (const [index, mount] of plan.externalMounts.entries()) {
		const filename = `external-${index}.tar`;
		const args = ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
			'--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
			'--user', `${process.getuid()}:${process.getgid()}`, '--tmpfs', '/tmp:rw,mode=1777',
			'--mount', mount.type === 'volume'
				? `type=volume,src=${mount.name},dst=/source,readonly`
				: `type=bind,src=${mount.physical},dst=/source,readonly`,
			'--mount', `type=bind,src=${plan.backup},dst=/backup`, '--entrypoint', 'tar', plan.sourceImageId];
		const selection = mount.type === 'volume' || mount.directory
			? ['--directory', '/source', '.'] : ['--directory', '/', 'source'];
		run('docker', [...args, '--create', '--sparse', '--file', `/backup/${filename}`, ...selection]);
		run('docker', [...args, '--compare', '--file', `/backup/${filename}`, ...selection]);
		chmodSync(join(plan.backup, filename), 0o600);
		write(`external-${index}.json`, { ...mount, archive: filename, sha256: digest(join(plan.backup, filename)) });
	}
	write('install-config.json', plan.config);
	const cli = (args) => run(plan.cli, ['--name', plan.target, ...args]);
	const history = join(plan.backup, 'native-history');
	cli(['history', 'export', '--from', plan.source, '--image', plan.sourceImageId, '--to', history,
		...(plan.runtime ? ['--runtime', plan.runtime] : [])]);
	const preparedHistory = prepareNativeHistory(history, join(plan.backup, 'prepared-native-history'));
	// --config is public operator input. Only the packaged installer writes
	// state/stack.json, system assets, secrets or installation provenance.
	cli([
		'install',
		'--config',
		join(plan.backup, 'install-config.json'),
		'--no-start'
	]);
	for (const directory of plan.directories)
		mkdirSync(safePath(plan.target, directory, true), { recursive: true, mode: 0o700 });
	for (const entry of plan.files) {
		const source = safePath(entry.root, entry.from);
		if (digest(source) !== entry.sha256)
			throw new Error(
				`Source changed after review: ${entry.from}. Keep both homes and the private backup.`
			);
		const target = safePath(plan.target, entry.to, true);
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		copyFileSync(source, target);
		chmodSync(target, entry.mode);
		if (digest(target) !== entry.sha256)
			throw new Error(`Copy verification failed: ${entry.to}. Do not start the destination.`);
	}
	const credentials = object(plan.sourceConfig.credentials, 'credentials');
	for (const [username, value] of Object.entries(credentials)) {
		if (
			!/^[a-z][a-z0-9._-]{0,63}$/.test(username) ||
			!['chat', 'read', 'full'].includes(value.policy)
		)
			throw new Error('Unsupported source credential.');
		cli([
			'credential',
			Object.hasOwn(plan.config.credentials, username) ? 'set-policy' : 'add',
			username,
			value.policy
		]);
	}
	for (const portal of ['discord', 'slack']) {
		const settings = plan.sourceConfig.portals[portal];
		cli(['portal', 'credential', portal, '--credential', settings.credential, '--no-apply']);
		const access = ['portal', 'access', portal, '--clear', '--no-apply'];
		for (const [key, values] of Object.entries(settings.access))
			access.push(`--${key === 'blockedUsers' ? 'blocked-users' : key}`, values.join(','));
		cli(access);
		for (const [user, username] of Object.entries(plan.maps[portal].users))
			cli(['credential', 'map', portal, user, username]);
		const token = safePath(plan.source, `state/secrets/${portal}_bot_token`, true);
		const appToken = portal === 'slack' ? safePath(plan.source, 'state/secrets/slack_app_token', true) : undefined;
		// Older installers seed empty secret files with a newline. That is not a
		// configured disabled bot; keep its raw file in the private archive only.
		const nonemptyToken = (path) => existsSync(path) && lstatSync(path).isFile() &&
			lstatSync(path).size > 0 && readFileSync(path, 'utf8').trim().length > 0;
		const configured = nonemptyToken(token) && (!appToken || nonemptyToken(appToken));
		if (settings.enabled || configured) {
			const args = ['portal', 'token', portal, '--bot-token-file', token, '--no-apply'];
			if (portal === 'slack')
				args.push('--app-token-file', appToken);
			cli(args);
		}
		if (settings.enabled) cli(['portal', 'enable', portal, '--no-apply']);
	}
	if (plan.sourceConfig.gateway.enabled) cli(['guardian', 'enable', '--no-apply']);
	const archive = json(join(history, 'history.json'));
	const directories = Object.fromEntries(
		archive.sessions.map((session) => {
			const dir = session.directory;
			const target = plan.suppliedDirectories ? plan.suppliedDirectories[dir] : dir;
			if (typeof target !== 'string' || (target !== '/work' && !target.startsWith('/work/')))
				throw new Error(
					'History includes an external project directory; supply a reviewed native-history mapping manually.'
				);
			if (target !== '/work' && !existsSync(safePath(plan.target, `workspace/${target.slice(6)}`)))
				throw new Error(
					'History project files are missing. Review the private archive before starting.'
				);
			return [dir, target];
		})
	);
	write('directories.json', directories);
	const restore = [
		'history',
		'restore',
		'--from',
		preparedHistory.archive,
		'--directory-map',
		join(plan.backup, 'directories.json')
	];
	if (plan.archiveInterrupted) restore.push('--archive-interrupted');
	cli(restore);
	cli([...restore, '--apply', '--same-instance']);
	write('migration-complete.json', {
		target: plan.target,
		version: plan.version,
		files: plan.files.length,
		history: {
			sessions: archive.sessions.length,
			messages: archive.sessions.reduce((n, s) => n + s.messages, 0),
			parts: archive.sessions.reduce((n, s) => n + s.parts, 0)
		},
		setupRequired: true,
		nativeRemoteChoices: {
			claude: plan.sourceConfig.assistant.claudeRemote,
			codex: plan.sourceConfig.assistant.codexRemote
		},
		nativePluginReviewRequired: plan.nativeAccounts,
		historyPreparation: preparedHistory,
		omitted: plan.omitted
	});
	return { target: plan.target, backup: plan.backup, files: plan.files.length };
}

export function main(argv = process.argv.slice(2)) {
	const { values } = parseArgs({
		args: argv,
		options: {
			from: { type: 'string' },
			to: { type: 'string' },
			name: { type: 'string' },
			fhold: { type: 'string' },
			'source-image': { type: 'string' },
			backup: { type: 'string' },
			apply: { type: 'boolean' },
			help: { type: 'boolean' },
			'include-provider-auth': { type: 'boolean' },
			'include-user-env': { type: 'boolean' },
			'include-native-accounts': { type: 'boolean' },
			'native-path': { type: 'string', multiple: true },
			'source-config': { type: 'string' },
			runtime: { type: 'string' },
			'directory-map': { type: 'string' },
			'archive-interrupted': { type: 'boolean' }
		}
	});
	if (values.help) {
		console.log(HELP);
		return;
	}
	const plan = planMigration(values);
	console.log(
		JSON.stringify(
			{
				mode: values.apply ? 'apply' : 'preview',
				source: plan.source,
				destination: plan.target,
				instance: values.name,
				version: plan.version,
				files: plan.files.length,
				bytes: plan.files.reduce((n, f) => n + f.bytes, 0),
				policies: Object.fromEntries(
					Object.entries(plan.sourceConfig.credentials).map(([k, v]) => [k, v.policy])
				),
				sourceMustBeStopped: plan.containers.filter((c) => c.running).map((c) => c.name),
				nativeAccounts: plan.nativeAccounts,
				tasksRemainInactive: true,
				freshAccessKeys: true,
				externalArchives: plan.externalMounts.map((m) => m.type === 'volume' ? { volume: m.name } : { source: m.physical }),
				omitted: plan.omitted
			},
			null,
			2
		)
	);
	if (values.apply) {
		console.log(JSON.stringify(applyMigration(plan)));
		console.log(
			'Transfer complete; destination remains stopped. Review native plugins and use fhold setup, doctor --readiness, connect, and guided remote setup before cutover acceptance.'
		);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		main();
	} catch (error) {
		console.error(error.message);
		process.exitCode = 1;
	}
}
