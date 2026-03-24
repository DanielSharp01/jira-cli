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

  db.run(`
    CREATE TABLE IF NOT EXISTS scan_dirs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS suggestion_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      issue_key TEXT NOT NULL,
      suggested_description TEXT,
      suggested_duration_seconds INTEGER,
      final_description TEXT,
      final_duration_seconds INTEGER,
      action TEXT NOT NULL,
      confidence TEXT,
      created_at TEXT NOT NULL
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
// Scan directories
// ---------------------------------------------------------------------------

export interface ScanDir {
  path: string;
  enabled: boolean;
}

export function getScanDirs(): ScanDir[] {
  const d = getDb();
  return (d.query(
    `SELECT path, enabled FROM scan_dirs ORDER BY id`
  ).all() as Array<{ path: string; enabled: number }>).map(r => ({
    path: r.path,
    enabled: r.enabled === 1,
  }));
}

export function addScanDirDb(path: string): void {
  const d = getDb();
  d.run(`INSERT OR IGNORE INTO scan_dirs (path, enabled) VALUES (?, 1)`, [path]);
}

export function removeScanDirDb(path: string): void {
  const d = getDb();
  d.run(`DELETE FROM scan_dirs WHERE path = ?`, [path]);
}

export function toggleScanDirDb(path: string, enabled: boolean): void {
  const d = getDb();
  d.run(`UPDATE scan_dirs SET enabled = ? WHERE path = ?`, [enabled ? 1 : 0, path]);
}

export function migrateScanDirsToDb(dirs: Array<{ path: string; enabled: boolean }>): void {
  const d = getDb();
  for (const dir of dirs) {
    d.run(`INSERT OR IGNORE INTO scan_dirs (path, enabled) VALUES (?, ?)`, [dir.path, dir.enabled ? 1 : 0]);
  }
}

// ---------------------------------------------------------------------------
// Suggestion feedback
// ---------------------------------------------------------------------------

export interface SuggestionFeedbackEntry {
  date: string;
  issueKey: string;
  suggestedDescription: string | null;
  suggestedDurationSeconds: number | null;
  finalDescription: string | null;
  finalDurationSeconds: number | null;
  action: "accepted" | "modified" | "rejected";
  confidence: string | null;
}

export function trackSuggestionFeedback(entry: SuggestionFeedbackEntry): void {
  const d = getDb();
  const now = new Date().toISOString();
  d.run(
    `INSERT INTO suggestion_feedback (date, issue_key, suggested_description, suggested_duration_seconds, final_description, final_duration_seconds, action, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [entry.date, entry.issueKey, entry.suggestedDescription, entry.suggestedDurationSeconds,
     entry.finalDescription, entry.finalDurationSeconds, entry.action, entry.confidence, now]
  );
}

export interface FeedbackSummary {
  issueKey: string;
  totalSuggested: number;
  accepted: number;
  modified: number;
  rejected: number;
  avgDurationCorrection: number | null; // seconds, positive = user increased, negative = user decreased
  commonCorrections: string[]; // e.g. "user prefers 'Sprint planning' over 'Agile ceremony'"
}

export function getSuggestionFeedbackSummary(limit = 20): FeedbackSummary[] {
  const d = getDb();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const rows = d.query(`
    SELECT
      issue_key as issueKey,
      COUNT(*) as totalSuggested,
      SUM(CASE WHEN action = 'accepted' THEN 1 ELSE 0 END) as accepted,
      SUM(CASE WHEN action = 'modified' THEN 1 ELSE 0 END) as modified,
      SUM(CASE WHEN action = 'rejected' THEN 1 ELSE 0 END) as rejected,
      AVG(CASE WHEN action = 'modified' AND final_duration_seconds IS NOT NULL AND suggested_duration_seconds IS NOT NULL
          THEN final_duration_seconds - suggested_duration_seconds ELSE NULL END) as avgDurationCorrection
    FROM suggestion_feedback
    WHERE date >= ?
    GROUP BY issue_key
    ORDER BY totalSuggested DESC
    LIMIT ?
  `).all(cutoffStr, limit) as Array<{
    issueKey: string;
    totalSuggested: number;
    accepted: number;
    modified: number;
    rejected: number;
    avgDurationCorrection: number | null;
  }>;

  // Get common description corrections
  return rows.map(row => {
    const corrections: string[] = [];
    if (row.modified > 0) {
      const descChanges = d.query(`
        SELECT suggested_description, final_description, COUNT(*) as cnt
        FROM suggestion_feedback
        WHERE issue_key = ? AND action = 'modified'
          AND suggested_description != final_description
          AND date >= ?
        GROUP BY suggested_description, final_description
        ORDER BY cnt DESC
        LIMIT 3
      `).all(row.issueKey, cutoffStr) as Array<{ suggested_description: string; final_description: string; cnt: number }>;

      for (const change of descChanges) {
        if (change.cnt >= 2) {
          corrections.push(`prefers "${change.final_description}" over "${change.suggested_description}"`);
        }
      }
    }

    return { ...row, commonCorrections: corrections };
  });
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
