import { parseEnvFile } from './env.js';
import { stackEnvFile } from './home.js';
import { patchStateEnvFile } from './secrets.js';

/**
 * Check if setup is complete.
 *
 * OP_SETUP_COMPLETE is an app-written record stored in state/stack.env
 * (constitution §1). Only OP_SETUP_COMPLETE=true is authoritative.
 */
export function isSetupComplete(homeDir: string): boolean {
  return parseEnvFile(stackEnvFile(homeDir)).OP_SETUP_COMPLETE === "true";
}

/**
 * Does this machine HOST an OpenPalm stack?
 *
 * Recorded rather than inferred. The routing that reads it needs to tell a
 * machine that runs a stack from one that only talks to a stack running
 * elsewhere, and that is a question about intent, not about which files happen
 * to be on disk. Inferring it from disk is what produced the trap this record
 * exists to end: the managed system/ tree is re-seeded on every launch, so a
 * machine that had installed nothing looked mid-install forever and was pinned
 * to a setup wizard it could not finish or dismiss.
 *
 * Default FALSE. Only an install writes it, so a machine that has never been
 * set up needs no record and gets the client treatment — which is what a
 * second laptop pointed at the household's stack actually wants.
 */
export function readHostEnabled(homeDir: string): boolean {
  if (parseEnvFile(stackEnvFile(homeDir)).OP_HOST_ENABLED === "true") return true;
  // Installs predating the flag: OP_SETUP_COMPLETE is already the canonical
  // record of a real, once-healthy install, so it answers for them and no
  // migration is needed. Drop this clause once the upgrade floor passes the
  // release that introduced OP_HOST_ENABLED.
  return isSetupComplete(homeDir);
}

/** Record that a stack is installed here. Written by install, nothing else. */
export function recordHostEnabled(homeDir: string): void {
  patchStateEnvFile(homeDir, { OP_HOST_ENABLED: "true" });
}
