/** Opt-in integration test against a disposable, already-onboarded Docker stack.
 * Run after Admin E2E with KEEP_RUNNING=true. Never target an operator home.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
	createCredentialId,
	ensureCredentialKeys,
	readStackConfig,
	writeStackConfig,
	readEnvFile,
	readCredentialKey
} from '../../lib/src/index.js';

const home = resolve(process.env.OPENPALM_LIVE_TEST_HOME || '/not-configured');
const stackEnv = readEnvFile(join(home, 'state', 'stack.env'));
assert(
	/^openpalm-(?:admin|live)-e2e-[a-z0-9_-]+$/.test(stackEnv.OP_PROJECT_NAME || ''),
	'Only disposable E2E projects may be tested'
);
assert(stackEnv.OP_HOME === home, 'Stack home does not match the requested test home');
const parsed = readStackConfig(home);
assert(parsed.ok, 'Invalid test stack intent');
const config = parsed.config;
assert(
	config.assistant.bindAddress === '127.0.0.1' && config.gateway.bindAddress === '127.0.0.1',
	'Live tests require loopback'
);
assert(
	config.gateway.enabled && config.assistant.automaticMemory,
	'Enable Guardian and automatic memory in this test fixture'
);
const tag = crypto.randomUUID().slice(0, 8);
const marker = `cedar-signal-${tag}`;
const taskId = `live-timer-${tag}`;
const nativeUrl = `http://127.0.0.1:${config.assistant.port}`;
const mcpUrl = new URL(`http://127.0.0.1:${config.gateway.port}/mcp`);
const password = readFileSync(
	join(home, 'state', 'secrets', 'op_opencode_password'),
	'utf8'
).trim();
const nativeHeaders = {
	authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
	'content-type': 'application/json'
};
const clients: Client[] = [];
const report: Record<string, unknown> = {
	version: 1,
	home,
	project: stackEnv.OP_PROJECT_NAME,
	checks: {},
	directModelRequests: 0
};
const checks = report.checks as Record<string, boolean>;

async function native(path: string, body?: unknown, method = body ? 'POST' : 'GET') {
	const response = await fetch(`${nativeUrl}${path}`, {
		method,
		headers: nativeHeaders,
		...(body ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(180_000)
	});
	assert(response.ok, `Native ${path} returned HTTP ${response.status}`);
	return await response.json();
}

async function prompt(session: string, text: string, tools = true): Promise<string> {
	report.directModelRequests = Number(report.directModelRequests) + 1;
	assert(Number(report.directModelRequests) <= 15, 'Live runner model request limit exceeded');
	const result = await native(`/session/${session}/message`, {
		agent: 'build',
		parts: [{ type: 'text', text }],
		...(!tools ? { tools: {} } : {})
	});
	assert(!result.info?.error, 'Native model request failed');
	return result.parts
		.filter((part: { type: string }) => part.type === 'text')
		.map((part: { text: string }) => part.text)
		.join('\n');
}

async function until(
	predicate: () => boolean | Promise<boolean>,
	description: string,
	timeout = 180_000
) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((done) => setTimeout(done, 1000));
	}
	throw new Error(`Timed out: ${description}`);
}

function filesBelow(root: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? filesBelow(join(root, entry.name))
			: entry.isFile()
				? [join(root, entry.name)]
				: []
	);
}

async function cli(...args: string[]) {
	const child = Bun.spawn([process.execPath, 'run', 'packages/cli/src/main.ts', ...args], {
		cwd: resolve(import.meta.dir, '../../..'),
		env: {
			...process.env,
			OP_HOME: home,
			OP_PROJECT_NAME: stackEnv.OP_PROJECT_NAME,
			OPENPALM_REPO_ROOT: resolve(import.meta.dir, '../../..')
		},
		stdout: 'pipe',
		stderr: 'pipe'
	});
	const [code, output] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text()
	]);
	if (code !== 0) throw new Error(`CLI ${args[0]} ${args[1] ?? ''} failed (exit ${code})`);
	return output;
}

async function connect(username: string, key = readCredentialKey(home, username)) {
	assert(key, 'Missing test credential');
	const client = new Client(
		{ name: 'openpalm-live-acceptance', version: '1' },
		{ capabilities: {}, versionNegotiation: { mode: 'auto' } }
	);
	clients.push(client);
	await client.connect(
		new StreamableHTTPClientTransport(mcpUrl, { authProvider: { token: async () => key } }),
		{ timeout: 15_000 }
	);
	return client;
}

async function tool(client: Client, name: string, args: Record<string, unknown>) {
	const result = await client.callTool({ name, arguments: args }, { timeout: 180_000 });
	assert(!result.isError, `${name} was rejected`);
	return result.structuredContent as Record<string, unknown>;
}

async function finished(client: Client, result: Record<string, unknown>) {
	const deadline = Date.now() + 180_000;
	let current = result;
	while (current.status === 'running' && Date.now() < deadline)
		current = await tool(client, 'openpalm.job.get', { job: current.job, waitMs: 30_000 });
	assert(current.status === 'completed', `Agent status was ${current.status}`);
	return current;
}

try {
	console.log('[live-acceptance] verifying automatic knowledge capture');
	const seed = await native('/session', {
		title: 'Disposable personal memory acceptance',
		permission: [{ permission: '*', pattern: '*', action: 'deny' }]
	});
	await prompt(
		seed.id,
		`My favorite personal project is ${marker}. This is a durable preference. Please acknowledge it briefly without using any tools.`,
		false
	);
	await until(
		() =>
			filesBelow(join(home, 'knowledge', 'memories')).some((path) =>
				readFileSync(path, 'utf8').includes(marker)
			),
		'automatic AKM fact capture'
	);
	checks.automaticMemory = true;

	console.log('[live-acceptance] creating recurring work through a natural-language request');
	const scheduled = await native('/session', { title: 'Disposable recurring-work acceptance' });
	await prompt(
		scheduled.id,
		`Create a recurring task named ${taskId}, scheduled every minute (* * * * *), with this prompt: Return exactly OPENPALM_TIMER_${tag}. Use openpalm-task create. Do not run it manually. Confirm creation.`
	);
	assert(
		existsSync(join(home, 'knowledge', 'tasks', `${taskId}.yml`)),
		'Agent did not create the requested task'
	);
	await until(
		async () =>
			filesBelow(join(home, 'data', 'akm', 'cache', 'tasks', 'logs', taskId)).some(
				(path) =>
					path.endsWith('.log') && readFileSync(path, 'utf8').includes(`OPENPALM_TIMER_${tag}`)
			) &&
			JSON.parse(await cli('task', 'history', taskId, '--json')).rows.some(
				(row: { status: string }) => row.status === 'completed'
			),
		'timer-triggered durable task result',
		240_000
	);
	await cli('task', 'pause', taskId);
	checks.timerExecution = true;
	checks.pause = true;

	console.log('[live-acceptance] applying refreshed assets and testing restart recall');
	await cli('update', '--no-pull');
	const recall = await native('/session', { title: 'Recall after update' });
	const recalled = await prompt(
		recall.id,
		'What is my favorite personal project? Search the AKM knowledge base for my stored preference before answering.'
	);
	assert(recalled.includes(marker), 'New session did not recall automatically retained knowledge');
	checks.updateAndRecall = true;
	await cli('task', 'resume', taskId);
	await cli('task', 'pause', taskId);
	checks.resume = true;

	for (const [name, policy] of [
		['live-full', 'full'],
		['live-read', 'read'],
		['live-chat', 'chat']
	] as const)
		config.credentials[name] = { id: createCredentialId(), policy };
	writeStackConfig(home, config);
	ensureCredentialKeys(home, config);
	const full = await connect('live-full');
	const read = await connect('live-read');
	const chat = await connect('live-chat');
	assert(
		!(await chat.listTools()).tools.some((item) => item.name.startsWith('openpalm.workspace.')),
		'Chat advertised workspace tools'
	);
	assert(
		(await read.listTools()).tools.some((item) => item.name === 'openpalm.workspace.read'),
		'Read lacks workspace access'
	);
	writeFileSync(join(home, 'workspace', 'live-public.txt'), 'safe workspace fixture');
	assert(
		(await tool(read, 'openpalm.workspace.read', { path: 'live-public.txt' })).text ===
			'safe workspace fixture'
	);
	const secretRead = await read.callTool({
		name: 'openpalm.workspace.read',
		arguments: { path: '../knowledge/secrets/auth.json' }
	});
	assert(secretRead.isError, 'Read escaped workspace');
	checks.policyCapabilities = true;
	checks.workspaceContainment = true;

	console.log('[live-acceptance] verifying resumable MCP jobs and credential isolation');
	report.directModelRequests = Number(report.directModelRequests) + 1;
	const job = await tool(full, 'openpalm.agent.run', {
		message: `Return exactly OPENPALM_MCP_${tag}. Do not use tools.`,
		title: `Disposable MCP acceptance ${tag}`,
		waitMs: 0
	});
	assert(typeof job.job === 'string' && typeof job.session === 'string');
	assert(
		(await read.callTool({ name: 'openpalm.job.get', arguments: { job: job.job } })).isError,
		'Another identity accessed the job'
	);
	const done = await finished(full, job);
	assert(
		String(done.text).includes(`OPENPALM_MCP_${tag}`),
		'MCP job did not produce the expected result'
	);
	const sessions = await tool(read, 'openpalm.session.list', {});
	assert.deepEqual(sessions.sessions, [], 'Fresh credential saw another identity’s sessions');
	checks.resumableMcpJob = true;
	checks.identityIsolation = true;

	console.log('[live-acceptance] verifying an explicit MCP permission decision');
	const owned = (await native('/session')).find(
		(session: { title: string }) => session.title === `Disposable MCP acceptance ${tag}`
	);
	assert(owned, 'Could not identify the disposable owned session');
	const command = `printf '%s\\n' 'OPENPALM_APPROVAL_${tag}'`;
	await native(
		`/session/${owned.id}`,
		{
			permission: [
				{ permission: '*', pattern: '*', action: 'deny' },
				{ permission: 'bash', pattern: command, action: 'ask' }
			]
		},
		'PATCH'
	);
	report.directModelRequests = Number(report.directModelRequests) + 1;
	let approval = await tool(full, 'openpalm.agent.run', {
		session: job.session,
		message: `Run exactly this harmless command using the bash tool: ${command}. Do not use other tools or commands. Return its output.`,
		waitMs: 0
	});
	await until(async () => {
		approval = await tool(full, 'openpalm.job.get', { job: approval.job, waitMs: 10_000 });
		assert(
			approval.status !== 'failed' && approval.status !== 'completed',
			'Expected an explicit permission request'
		);
		return approval.status === 'input_required';
	}, 'MCP permission request');
	const interaction = (approval.interactions as Array<{ kind: string; handle: string }>).find(
		(item) => item.kind === 'permission'
	);
	assert(interaction, 'Missing permission interaction');
	assert(
		(
			await read.callTool({
				name: 'openpalm.interaction.respond',
				arguments: {
					interaction: interaction.handle,
					decision: 'once'
				}
			})
		).isError,
		'Another identity approved a permission'
	);
	await tool(full, 'openpalm.interaction.respond', {
		interaction: interaction.handle,
		decision: 'once'
	});
	await until(async () => {
		approval = await tool(full, 'openpalm.job.get', { job: approval.job, waitMs: 10_000 });
		assert(approval.status !== 'failed', 'Approved operation failed');
		return approval.status === 'completed';
	}, 'Approved MCP operation');
	assert(
		String(approval.text).includes(`OPENPALM_APPROVAL_${tag}`),
		'Approved command did not produce its result'
	);
	checks.permissionApproval = true;

	const oldKey = readCredentialKey(home, 'live-read');
	await cli('credential', 'rotate', 'live-read');
	const rejected = await fetch(mcpUrl, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${oldKey}`,
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream'
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
	});
	assert(rejected.status === 401, 'Rotated key still authenticated');
	assert((await (await connect('live-read')).listTools()).tools.length > 0);
	checks.credentialRotation = true;
	report.ok = true;
} catch (error) {
	report.ok = false;
	// Do not print model output, transport bodies or credential-bearing errors.
	report.failure =
		error instanceof assert.AssertionError
			? error.message
			: 'A live integration step failed; inspect private local logs';
	process.exitCode = 1;
} finally {
	for (const client of clients) await client.close().catch(() => {});
	if (existsSync(join(home, 'knowledge', 'tasks', `${taskId}.yml`)))
		await cli('task', 'pause', taskId).catch(() => {});
	const output = process.env.OPENPALM_LIVE_TEST_REPORT;
	if (output) {
		mkdirSync(resolve(output, '..'), { recursive: true });
		writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
	}
	console.log(JSON.stringify(report, null, 2));
}
