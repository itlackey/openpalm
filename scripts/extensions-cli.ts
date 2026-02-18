const [,, cmd, ...rest] = Bun.argv;
const base = Bun.env.ADMIN_APP_URL ?? Bun.env.GATEWAY_URL ?? "http://localhost/admin";
const admin = Bun.env.ADMIN_TOKEN ?? "";

function arg(name: string) {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

async function run() {
  if (!cmd) {
    console.log("Usage: bun run scripts/extensions-cli.ts <install|uninstall|list> [--plugin <id>]");
    process.exit(1);
  }

  const headers: Record<string,string> = { "content-type": "application/json", "x-admin-token": admin };

  if (cmd === "install") {
    const pluginId = arg("plugin");
    if (!pluginId) { console.error("--plugin required"); process.exit(1); }
    const res = await fetch(`${base}/admin/gallery/install`, { method: "POST", headers, body: JSON.stringify({ pluginId }) });
    console.log(await res.text());
    return;
  }
  if (cmd === "uninstall") {
    const pluginId = arg("plugin");
    if (!pluginId) { console.error("--plugin required"); process.exit(1); }
    const res = await fetch(`${base}/admin/gallery/uninstall`, { method: "POST", headers, body: JSON.stringify({ pluginId }) });
    console.log(await res.text());
    return;
  }
  if (cmd === "list") {
    const res = await fetch(`${base}/admin/installed`, { headers: { "x-admin-token": admin } });
    console.log(await res.text());
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
