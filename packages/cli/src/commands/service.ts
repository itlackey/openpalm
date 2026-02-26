import { loadComposeConfig } from "@openpalm/lib/config.ts";
import { composePull, composeUp } from "@openpalm/lib/compose.ts";
import { error, info } from "@openpalm/lib/ui.ts";
import { getAdminClient, adminEnvContext } from "./admin.ts";
import { start } from "./start.ts";
import { stop } from "./stop.ts";
import { restart } from "./restart.ts";
import { logs } from "./logs.ts";
import { status } from "./status.ts";

function getArg(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function getServices(args: string[]): string[] {
  const services: string[] = [];
  let index = 0;
  while (index < args.length) {
    const item = args[index];
    if (item.startsWith("--")) {
      const flag = item.slice(2);
      if (flag === "tail") {
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    services.push(item);
    index += 1;
  }
  return services;
}

export async function service(subcommand: string, args: string[]): Promise<void> {
  const services = getServices(args);
  const selectedServices = services.length > 0 ? services : undefined;
  const { explicit } = await adminEnvContext();
  const serviceName = services[0];

  if (!explicit) {
    if (subcommand === "up") return await start(selectedServices);
    if (subcommand === "stop") return await stop(selectedServices);
    if (subcommand === "restart") return await restart(selectedServices);
    if (subcommand === "logs") return await logs(selectedServices);
    if (subcommand === "status") return await status();
    if (subcommand === "update") {
      const config = await loadComposeConfig();
      if (services.length > 0) {
        await composePull(config, services);
        await composeUp(config, services, { pull: "always" });
      } else {
        await composePull(config);
        await composeUp(config, undefined, { pull: "always" });
      }
      return;
    }
    error(`Unknown service subcommand: ${subcommand}`);
    info("Usage: openpalm service <up|stop|restart|logs|update|status> [service...]");
    process.exit(1);
  }

  if (subcommand === "status") {
    const client = await getAdminClient();
    const result = await client.listContainers();
    info(JSON.stringify(result, null, 2));
    return;
  }
  if (!serviceName) {
    error("A service name is required in admin API mode");
    info("Usage: openpalm service <up|stop|restart|logs|update> <service>");
    process.exit(1);
  }
  if (subcommand === "up") {
    const client = await getAdminClient();
    const result = await client.containerUp(serviceName);
    info(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "stop") {
    const client = await getAdminClient();
    const result = await client.containerStop(serviceName);
    info(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "restart") {
    const client = await getAdminClient();
    const result = await client.containerRestart(serviceName);
    info(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "update") {
    const client = await getAdminClient();
    const result = await client.containerUpdate(serviceName);
    info(JSON.stringify(result, null, 2));
    return;
  }
  if (subcommand === "logs") {
    const tailRaw = getArg(args, "tail");
    let tail: number | undefined;
    if (tailRaw) {
      tail = Number(tailRaw);
      if (!Number.isInteger(tail) || tail < 1) {
        throw new Error("The --tail parameter must be a positive integer");
      }
    }
    const client = await getAdminClient();
    const result = await client.serviceLogs(serviceName, tail);
    info(JSON.stringify(result, null, 2));
    return;
  }
  error(`Unknown service subcommand: ${subcommand}`);
  info("Usage: openpalm service <up|stop|restart|logs|update|status> [service...]");
  process.exit(1);
}
