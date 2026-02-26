type ChannelPayload = {
  userId: string;
  channel: string;
  text: string;
  metadata?: Record<string, unknown>;
};

type InboundResult =
  | { ok: true; payload: ChannelPayload }
  | { ok: false; status: number; body: unknown };

type HealthStatus = {
  ok: boolean;
  service: string;
  detail?: string;
};

type ChannelRoute = {
  method: string;
  path: string;
  handler: (req: Request) => Promise<InboundResult>;
};

export type ChannelAdapter = {
  name: string;
  routes: ChannelRoute[];
  health: () => HealthStatus;
};
