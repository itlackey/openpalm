/**
 * Secure token generation with no external dependencies
 */

/**
 * Generate a cryptographically secure URL-safe base64 token
 * @param length - Desired length of the output string (default: 64)
 * @returns URL-safe base64 encoded random token
 */
export function generateToken(length: number = 64): string {
  // Calculate how many bytes we need to get approximately the desired length
  // Base64 encoding produces 4 characters for every 3 bytes
  // We'll generate extra bytes and trim to exact length
  const bytesNeeded = Math.ceil((length * 3) / 4);
  const randomBytes = new Uint8Array(bytesNeeded);

  // Fill with cryptographically secure random values
  crypto.getRandomValues(randomBytes);

  // Convert to base64
  let base64 = btoa(String.fromCharCode(...randomBytes));

  // Convert to URL-safe base64: replace + with -, / with _, and remove =
  const urlSafeBase64 = base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  // Trim to exact desired length
  return urlSafeBase64.slice(0, length);
}
