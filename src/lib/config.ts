import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "./types.ts";

const CONFIG_DIR = join(homedir(), ".config", "jira-cli");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function configExists(): boolean {
  return existsSync(CONFIG_FILE);
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    throw new Error(
      `No config found. Run \`jira config\` to set up.`
    );
  }
  const raw = readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(raw) as Config;
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Resolves a PAT value. Supports:
 *   "$JIRA_PAT"  → looks up process.env.JIRA_PAT
 *   "abc123"     → used directly
 * Falls back to direct env var lookup if config value is missing.
 */
export function resolvePat(value: string | undefined, envFallback: string): string {
  const raw = value ?? `$${envFallback}`;
  if (raw.startsWith("$")) {
    const envKey = raw.slice(1);
    const resolved = process.env[envKey];
    if (!resolved) {
      throw new Error(
        `Environment variable $${envKey} is not set. Set it or store the token directly in ~/.config/jira-cli/config.json.`
      );
    }
    return resolved;
  }
  return raw;
}

export function getJiraPat(config: Config): string {
  return resolvePat(config.jiraPat, "JIRA_PAT");
}

export function getTempoPat(config: Config): string {
  return resolvePat(config.tempoPat, "TEMPO_PAT");
}

