/**
 * Resolves the host port assigned by Docker Compose for a service's container port.
 *
 * Requires the compose project to be running with port "0:<container_port>" mappings.
 * Calls `docker compose port <service> <container_port>` and parses the output.
 */
export async function resolveHostPort(
  composeArgs: string[],
  service: string,
  containerPort: number,
  cwd: string,
): Promise<number> {
  const proc = Bun.spawn(
    ["docker", "compose", ...composeArgs, "port", service, String(containerPort)],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();

  if (exitCode !== 0) {
    throw new Error(
      `Failed to resolve port for ${service}:${containerPort}: ${stderr}`,
    );
  }

  // Output format: "0.0.0.0:12345" or "127.0.0.1:12345" or "[::]:12345"
  const match = stdout.match(/:(\d+)$/);
  if (!match) {
    throw new Error(
      `Unexpected docker compose port output for ${service}:${containerPort}: "${stdout}"`,
    );
  }

  return Number(match[1]);
}
