type StoppableServer = {
  stop: (closeActiveConnections?: boolean) => void;
  port?: number;
};

type ShutdownLogger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  warn: (message: string, data?: Record<string, unknown>) => void;
};

export function installGracefulShutdown(
  server: StoppableServer,
  options?: {
    service?: string;
    logger?: ShutdownLogger;
    cleanup?: () => void;
  },
): void {
  let stopping = false;
  const service = options?.service ?? "server";

  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;

    options?.logger?.info("shutdown_started", { service, signal, port: server.port });
    try {
      options?.cleanup?.();
    } catch (error) {
      options?.logger?.warn("shutdown_cleanup_failed", { service, error: String(error) });
    }

    try {
      server.stop(true);
      options?.logger?.info("shutdown_complete", { service });
      process.exit(0);
    } catch (error) {
      options?.logger?.warn("shutdown_stop_failed", { service, error: String(error) });
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
