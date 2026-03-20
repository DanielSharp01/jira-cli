import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { parseIssueFile } from "./format.ts";
import type { ParsedIssueFile } from "./types.ts";

const CONFIG_DIR = join(homedir(), ".config", "jira-cli");

// ---------------------------------------------------------------------------
// Snapshot paths — mirrors git's index (last known remote state)
// Stored at: ~/.config/jira-cli/remote/<key>.md
// ---------------------------------------------------------------------------

export function snapshotPath(key: string): string {
  return join(CONFIG_DIR, "remote", `${key}.md`);
}

export function readSnapshot(key: string): ParsedIssueFile | null {
  const snapPath = snapshotPath(key);
  if (!existsSync(snapPath)) return null;
  try {
    return parseIssueFile(readFileSync(snapPath, "utf-8"));
  } catch {
    return null;
  }
}

export function writeSnapshot(key: string, markdown: string): void {
  const snapPath = snapshotPath(key);
  mkdirSync(dirname(snapPath), { recursive: true });
  writeFileSync(snapPath, markdown, "utf-8");
}

// ---------------------------------------------------------------------------
// Active file tracking — ~/.config/jira-cli/active.json
// Maps issue key → absolute path of the local .md file
// ---------------------------------------------------------------------------

function activeFilePath(): string {
  return join(CONFIG_DIR, "active.json");
}

function loadActiveMap(): Record<string, string> {
  const p = activeFilePath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function setActiveFile(key: string, filePath: string): void {
  const map = loadActiveMap();
  map[key] = filePath;
  const p = activeFilePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(map, null, 2), "utf-8");
}

export function getActiveFile(key: string): string | null {
  return loadActiveMap()[key] ?? null;
}

/**
 * Moves the issue file to a new path and updates active.json.
 * No-ops if the file doesn't exist or paths are the same.
 */
export function moveIssueFile(key: string, newPath: string): void {
  const oldPath = getActiveFile(key);
  if (!oldPath || oldPath === newPath) return;
  if (!existsSync(oldPath)) {
    setActiveFile(key, newPath);
    return;
  }
  mkdirSync(dirname(newPath), { recursive: true });
  renameSync(oldPath, newPath);
  setActiveFile(key, newPath);
}

// ---------------------------------------------------------------------------
// Targeted in-place field updates — used after status/comment to avoid
// a full re-fetch of the issue file
// ---------------------------------------------------------------------------

/**
 * Replaces the "Field: <value>" line in a file. Case-insensitive on field name.
 * No-ops if the file doesn't exist.
 */
export function updateFieldLine(filePath: string, field: string, value: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf-8");
  const regex = new RegExp(`^${field}:.*$`, "im");
  if (!regex.test(content)) return;
  writeFileSync(filePath, content.replace(regex, `${field}: ${value}`), "utf-8");
}

/**
 * Appends a comment blockquote to the ## Comments section of a file.
 * Creates the section if it doesn't already exist.
 * No-ops if the file doesn't exist.
 */
export function appendComment(
  filePath: string,
  author: string,
  date: string,
  body: string
): void {
  if (!existsSync(filePath)) return;
  let content = readFileSync(filePath, "utf-8");

  const block =
    `> **${author}** — ${date}\n` +
    body
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n") +
    "\n";

  if (content.includes("## Comments")) {
    if (!content.endsWith("\n")) content += "\n";
    content += `\n${block}`;
  } else {
    if (!content.endsWith("\n")) content += "\n";
    content += `\n---\n\n## Comments\n\n${block}`;
  }

  writeFileSync(filePath, content, "utf-8");
}
