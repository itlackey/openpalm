/**
 * Shared cryptographic utilities for the control plane.
 */
import { createHash, randomBytes } from "node:crypto";

/** SHA-256 hex digest of a string. */
export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Generate a hex string using Node's crypto.randomBytes (CSPRNG). */
export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
