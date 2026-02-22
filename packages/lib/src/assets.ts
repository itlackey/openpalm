import { join } from "node:path";
import { DEFAULT_OPENPALM_YAML, DEFAULT_SECRETS_ENV } from "../assets/templates/index.ts";

export async function seedConfigFiles(configHome: string): Promise<void> {
  const yamlPath = join(configHome, "openpalm.yaml");
  const secretsPath = join(configHome, "secrets.env");
  if (!await Bun.file(yamlPath).exists()) await Bun.write(yamlPath, DEFAULT_OPENPALM_YAML);
  if (!await Bun.file(secretsPath).exists()) await Bun.write(secretsPath, DEFAULT_SECRETS_ENV);
}
