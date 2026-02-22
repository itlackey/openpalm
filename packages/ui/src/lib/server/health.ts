export async function checkServiceHealth(
	url: string,
	expectJson = true
): Promise<{ ok: boolean; time?: string; error?: string }> {
	try {
		const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
		if (!resp.ok) return { ok: false, error: `status ${resp.status}` };
		if (!expectJson) return { ok: true, time: new Date().toISOString() };
		const body = (await resp.json()) as { ok?: boolean; time?: string };
		return { ok: body.ok ?? true, time: body.time };
	} catch (e) {
		return { ok: false, error: String(e) };
	}
}
