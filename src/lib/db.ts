import { Database } from "bun:sqlite";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".config", "jira-cli");
const DB_PATH = join(CONFIG_DIR, "jira-cli.db");

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;

  mkdirSync(CONFIG_DIR, { recursive: true });
  try {
    db = new Database(DB_PATH);
    db.run("PRAGMA journal_mode = WAL");
  } catch {
    // If db is corrupt, delete and recreate
    try { unlinkSync(DB_PATH); } catch { /* ignore */ }
    db = new Database(DB_PATH);
    db.run("PRAGMA journal_mode = WAL");
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS description_prefs (
      issue_key TEXT NOT NULL,
      description TEXT NOT NULL,
      usage_count INTEGER NOT NULL DEFAULT 1,
      last_used TEXT NOT NULL,
      PRIMARY KEY (issue_key, description)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      provider TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  return db;
}

export function trackDescription(issueKey: string, description: string): void {
  const d = getDb();
  const now = new Date().toISOString();
  d.run(
    `INSERT INTO description_prefs (issue_key, description, usage_count, last_used)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(issue_key, description) DO UPDATE SET
       usage_count = usage_count + 1,
       last_used = ?`,
    [issueKey, description, now, now]
  );
}

export interface DescriptionPref {
  issueKey: string;
  description: string;
  usageCount: number;
}

export function getPreferredDescriptions(issueKey: string, limit = 5): DescriptionPref[] {
  const d = getDb();
  return d.query(
    `SELECT issue_key as issueKey, description, usage_count as usageCount
     FROM description_prefs
     WHERE issue_key = ?
     ORDER BY usage_count DESC
     LIMIT ?`
  ).all(issueKey, limit) as DescriptionPref[];
}

export function getAllPreferredDescriptions(limit = 50): DescriptionPref[] {
  const d = getDb();
  return d.query(
    `SELECT issue_key as issueKey, description, usage_count as usageCount
     FROM description_prefs
     ORDER BY usage_count DESC
     LIMIT ?`
  ).all(limit) as DescriptionPref[];
}

export function deleteDescriptionPref(issueKey: string, description: string): void {
  const d = getDb();
  d.run(`DELETE FROM description_prefs WHERE issue_key = ? AND description = ?`, [issueKey, description]);
}

export function clearAllDescriptionPrefs(): void {
  const d = getDb();
  d.run(`DELETE FROM description_prefs`);
}

// ---------------------------------------------------------------------------
// OAuth tokens
// ---------------------------------------------------------------------------

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export function saveOAuthTokens(provider: string, tokens: OAuthTokens): void {
  const d = getDb();
  d.run(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       access_token = ?, refresh_token = ?, expires_at = ?`,
    [provider, tokens.accessToken, tokens.refreshToken, tokens.expiresAt,
     tokens.accessToken, tokens.refreshToken, tokens.expiresAt]
  );
}

export function getOAuthTokens(provider: string): OAuthTokens | null {
  const d = getDb();
  const row = d.query(
    `SELECT access_token as accessToken, refresh_token as refreshToken, expires_at as expiresAt
     FROM oauth_tokens WHERE provider = ?`
  ).get(provider) as OAuthTokens | null;
  return row;
}

export function deleteOAuthTokens(provider: string): void {
  const d = getDb();
  d.run(`DELETE FROM oauth_tokens WHERE provider = ?`, [provider]);
}
