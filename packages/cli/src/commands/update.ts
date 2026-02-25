import { composePull, composeUp } from "@openpalm/lib/compose.ts";
import { loadComposeConfig } from "@openpalm/lib/config.ts";
import { resolveXDGPaths } from "@openpalm/lib/paths.ts";
import { readInstallMetadata, writeInstallMetadata, appendMetadataEvent } from "@openpalm/lib/install-metadata.ts";
import { info, green } from "@openpalm/lib/ui.ts";

export async function update(): Promise<void> {
  const config = await loadComposeConfig();
  info("Pulling latest images...");
  await composePull(config);
  info("Recreating containers with updated images...");
  await composeUp(config, undefined, { pull: "always" });

  const xdg = resolveXDGPaths();
  const metadata = readInstallMetadata(xdg.state);
  if (metadata) {
    const updated = appendMetadataEvent(metadata, {
      action: "update",
      timestamp: new Date().toISOString(),
    });
    writeInstallMetadata(xdg.state, updated);
  }

  info(green("Update complete."));
}
