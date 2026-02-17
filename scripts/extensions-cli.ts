const [,, cmd, ...rest] = Bun.argv;
const base = Bun.env.ADMIN_APP_URL ?? Bun.env.GATEWAY_URL ?? "http://localhost/admin";
const admin = Bun.env.ADMIN_TOKEN ?? "";
const step = Bun.env.ADMIN_STEP_UP_TOKEN ?? "";

function arg(name: string) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function run() {
  if (!cmd) {
    console.log("Usage: bun run scripts/extensions-cli.ts <request|list|apply|disable> [--plugin <id>|--request <id>]");
    process.exit(1);
  }

  const headers: Record<string,string> = { "content-type": "application/json", "x-admin-token": admin };
  if (["apply","disable"].includes(cmd)) headers["x-admin-step-up"] = step;

  if (cmd === "request") {
    const pluginId = arg("plugin");
    const res = await fetch(`${base}/admin/extensions/request`, { method: "POST", headers, body: JSON.stringify({ pluginId }) });
    console.log(await res.text());
    return;
  }
  if (cmd === "list") {
    const res = await fetch(`${base}/admin/extensions/list`, { headers: { "x-admin-token": admin } });
    console.log(await res.text());
    return;
  }
  if (cmd === "apply") {
    const requestId = arg("request");
    const res = await fetch(`${base}/admin/extensions/apply`, { method: "POST", headers, body: JSON.stringify({ requestId }) });
    console.log(await res.text());
    return;
  }
  if (cmd === "disable") {
    const pluginId = arg("plugin");
    const res = await fetch(`${base}/admin/extensions/disable`, { method: "POST", headers, body: JSON.stringify({ pluginId }) });
    console.log(await res.text());
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
