/**
 * Generate a cryptographically secure URL-safe base64 token
 * @param length - Desired length of the output string (default: 64)
 * @returns URL-safe base64 encoded random token
 */
export function generateToken(length: number = 64): string {
  const bytesNeeded = Math.ceil((length * 3) / 4);
  const randomBytes = new Uint8Array(bytesNeeded);
  crypto.getRandomValues(randomBytes);
  let base64 = btoa(String.fromCharCode(...randomBytes));
  const urlSafeBase64 = base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
  return urlSafeBase64.slice(0, length);
}
