/**
 * Standard channel adapter interface.
 *
 * These types define the shared adapter contract used by channel wrappers.
 * The adapter is responsible for:
 * 1. Accepting inbound requests from its platform
 * 2. Optionally authenticating the caller (inbound token, webhook secret, etc.)
 * 3. Normalizing the request into a ChannelPayload
 * 4. Returning the payload so the harness can HMAC-sign and forward to the gateway
 */

/** Normalized message payload sent to the gateway. */
type ChannelPayload = {
  userId: string;
  channel: string;
  text: string;
  metadata?: Record<string, unknown>;
};

/** Result of processing an inbound request. */
type InboundResult =
  | { ok: true; payload: ChannelPayload }
  | { ok: false; status: number; body: unknown };

/** Health check response. */
type HealthStatus = {
  ok: boolean;
  service: string;
  detail?: string;
};

/** Route definition for the channel adapter. */
type ChannelRoute = {
  /** HTTP method (e.g. "POST", "GET"). */
  method: string;
  /** URL path (e.g. "/my-channel/webhook"). */
  path: string;
  /** Handler that processes the inbound request and returns a normalized result. */
  handler: (req: Request) => Promise<InboundResult>;
};

/** The standard interface every channel adapter must implement. */
export type ChannelAdapter = {
  /** Unique channel name — must match the gateway's ALLOWED_CHANNELS entry. */
  name: string;

  /** One or more routes this adapter handles. */
  routes: ChannelRoute[];

  /** Health check for this adapter. */
  health: () => HealthStatus;
};
