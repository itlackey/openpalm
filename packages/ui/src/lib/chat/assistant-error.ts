/**
 * Pure HTTP-status -> user-facing message mapping for assistant/API errors.
 *
 * Extracted from chat-state.svelte.ts so the three call sites (loadSessions,
 * openSession, send) share one ladder and so the mapping unit-tests without
 * mounting a Svelte component. Keeping it non-reactive is deliberate — no
 * runes, no imports from the chat state.
 */

/**
 * The narrow shape we read off a thrown API error.
 *
 * `detail` is distinct from `message`: it's set ONLY when a caller extracted a
 * genuine structured message (the `/oc` proxy's own envelope, OpenCode's error
 * JSON, or — for `session.error` SSE events, which never go through an HTTP
 * throw — `properties.error`). `message` may just be a generic placeholder
 * (e.g. transport/direct.ts's `HTTP 404` when no body could be parsed), so the
 * ladder below prefers `detail` and only falls back to `message` for statuses
 * it has no dedicated copy for (see mapAssistantError).
 */
export type AssistantErrorLike = {
	status?: number;
	message?: string;
	detail?: string;
	code?: string;
	requestId?: string;
};

export type MapAssistantErrorOptions = {
	/** Message used when the error has no recognized status and no message. */
	fallback?: string;
	/**
	 * Append " Try reconnecting." to the unreachable message. The session-load
	 * (`loadSessions`) surface omits the hint; the message-send surfaces show it.
	 */
	reconnectHint?: boolean;
};

/**
 * Map an unknown thrown value to a user-facing string.
 *
 * - 503 / 502 -> a structured `detail` when present (e.g. the `/oc` proxy's
 *   own "may still be starting" copy), else "Assistant is not reachable."
 *   (+ " Try reconnecting." when `reconnectHint` is set).
 * - 401 -> "Sign-in required." — a fixed app-level message regardless of
 *   `detail`, since this status is our own session check, not a domain error
 *   the assistant produced.
 * - otherwise -> `detail`, falling back to the error's own `message`, falling
 *   back to `fallback`.
 */
export function mapAssistantError(
	e: unknown,
	opts: MapAssistantErrorOptions = {}
): string {
	const { fallback = 'Something went wrong.', reconnectHint = false } = opts;
	const err = (e ?? {}) as AssistantErrorLike;
	const detail = typeof err.detail === 'string' && err.detail.trim() ? err.detail : undefined;
	if (err.status === 503 || err.status === 502) {
		const base = detail ?? 'Assistant is not reachable.';
		return reconnectHint ? `${base} Try reconnecting.` : base;
	}
	if (err.status === 401) {
		return 'Sign-in required.';
	}
	return detail ?? err.message ?? fallback;
}
