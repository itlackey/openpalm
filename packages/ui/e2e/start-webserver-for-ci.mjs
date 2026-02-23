import { spawn } from 'node:child_process';
import { webServerEnv } from './env.ts';

const child = spawn('node', ['e2e/start-webserver.cjs'], {
	cwd: process.cwd(),
	stdio: 'inherit',
	env: { ...process.env, ...webServerEnv() }
});

const forwardSignal = (signal) => {
	if (!child.killed) child.kill(signal);
};

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('exit', (code) => {
	process.exit(code ?? 1);
});
