export function generateToken(length: number = 64): string {
  const bytesNeeded = Math.ceil((length * 3) / 4);
  const randomBytes = new Uint8Array(bytesNeeded);
  crypto.getRandomValues(randomBytes);
  const base64 = btoa(String.fromCharCode(...randomBytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "").slice(0, length);
}
