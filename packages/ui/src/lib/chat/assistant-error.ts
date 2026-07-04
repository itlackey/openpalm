/**
 * Pure HTTP-status -> user-facing message mapping for assistant/API errors.
 *
 * Extracted from chat-state.svelte.ts so the three call sites (loadSessions,
 * openSession, send) share one ladder and so the mapping unit-tests without
 * mounting a Svelte component. Keeping it non-reactive is deliberate — no
 * runes, no imports from the chat state.
 */

/** The narrow shape we read off a thrown API error. */
export type AssistantErrorLike = { status?: number; message?: string };

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
 * - 503 / 502 -> "Assistant is not reachable." (+ " Try reconnecting." when
 *   `reconnectHint` is set).
 * - 401 -> "Sign-in required."
 * - otherwise -> the error's own `message`, falling back to `fallback`.
 */
export function mapAssistantError(
	e: unknown,
	opts: MapAssistantErrorOptions = {}
): string {
	const { fallback = 'Something went wrong.', reconnectHint = false } = opts;
	const err = (e ?? {}) as AssistantErrorLike;
	if (err.status === 503 || err.status === 502) {
		return reconnectHint
			? 'Assistant is not reachable. Try reconnecting.'
			: 'Assistant is not reachable.';
	}
	if (err.status === 401) {
		return 'Sign-in required.';
	}
	return err.message ?? fallback;
}
