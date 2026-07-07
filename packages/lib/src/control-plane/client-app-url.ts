export const DEFAULT_CLIENT_PORT = 3890;

export function resolveClientAppPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.OP_HOST_CLIENT_PORT) || DEFAULT_CLIENT_PORT;
}

export function resolveClientAppUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${resolveClientAppPort(env)}/chat`;
}
