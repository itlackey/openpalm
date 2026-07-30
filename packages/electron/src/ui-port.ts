/**
 * The host UI port this harness serves on — resolved once, read everywhere.
 *
 * `main.ts` and `permissions.ts` both need this answer, and they must agree
 * exactly: `main.ts` decides which port the UI child binds and which URL the
 * window loads, while `permissions.ts` approves microphone capture only for that
 * exact origin. When the port consolidation taught `main.ts` to read a persisted
 * `OP_HOST_UI_PORT` out of `state/stack.env`, `permissions.ts` kept resolving
 * from live env alone — so on precisely the custom-port installs the change was
 * meant to support, the window loaded 127.0.0.1:<persisted> while the permission
 * handlers still expected 3880, denied the request, and left the mic silently
 * recording nothing (which is how a phantom "You" transcription happens).
 *
 * Module scope, evaluated once at import: the UI child is spawned with this port
 * for the app's whole lifetime, so a later stack.env edit must NOT make the
 * permission check disagree with the running window. One value, one read.
 */
import { parseEnvFile, resolveHostUiPort, resolveOpenPalmHome, stackEnvFile } from '@openpalm/lib';

export const UI_PORT = resolveHostUiPort(
  undefined,
  process.env,
  parseEnvFile(stackEnvFile(resolveOpenPalmHome())),
);
