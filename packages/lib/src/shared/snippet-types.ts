/**
 * Shared types for channel/service env var declarations.
 */

/** A single environment variable declaration. */
export type EnvVarDef = {
  /** Environment variable name (UPPER_CASE). */
  name: string;
  /** Help text describing the variable's purpose. */
  description?: string;
  /** Whether a value or secret reference must be provided. */
  required: boolean;
  /** Default value if none is provided. */
  default?: string;
};

/**
 * Return "password" for env var names that look like secrets, "text" otherwise.
 * Convention: names containing SECRET, TOKEN, KEY, or PASSWORD are masked.
 */
export function inferInputType(envName: string): string {
  const upper = envName.toUpperCase();
  if (upper.includes("SECRET") || upper.includes("TOKEN") || upper.includes("KEY") || upper.includes("PASSWORD")) {
    return "password";
  }
  return "text";
}
