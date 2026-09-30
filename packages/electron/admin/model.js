export const csv = (value) =>
	value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);

export function readinessResult(value) {
	return value && typeof value === 'object' && typeof value.ok === 'boolean';
}

export function dialAddress(address) {
	if (address === '0.0.0.0') return '127.0.0.1';
	if (address === '::') return '::1';
	return address;
}

export function endpoint(address, port, path = '') {
	const host = dialAddress(address);
	return `http://${host.includes(':') ? `[${host}]` : host}:${port}${path}`;
}

export function isRunning(service) {
	return service?.state.toLowerCase().includes('running');
}

export function isHealthy(service) {
	return isRunning(service) && (!service.health || service.health.toLowerCase() === 'healthy');
}

export function friendlyServiceName(name) {
	if (name === 'assistant') return 'Personal Assistant';
	if (name === 'guardian') return 'Protected access';
	if (name === 'discord') return 'Discord';
	if (name === 'slack') return 'Slack';
	return name;
}

export function promptVisible(prompt, values) {
	if (!prompt.when) return true;
	const matches = values[prompt.when.key] === prompt.when.value;
	return prompt.when.op === 'eq' ? matches : !matches;
}
