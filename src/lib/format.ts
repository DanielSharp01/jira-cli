import type { JiraIssue, JiraComment, ParsedIssueFile } from "./types.ts";
import { adfToMarkdown } from "./adf.ts";

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Renders a JIRA issue as a Markdown file string.
 */
export function issueToMarkdown(
  issue: JiraIssue,
  opts: { includeComments?: boolean; sprintRange?: string } = {}
): string {
  const f = issue.fields;
  const key = issue.key;
  const summary = f.summary;

  const lines: string[] = [];

  lines.push(`# ${key} - ${summary}`);
  lines.push("");

  lines.push(`Type: ${f.issuetype.name}`);
  lines.push(`Status: ${f.status.name}`);
  lines.push(`Assignee: ${f.assignee?.emailAddress ?? f.assignee?.displayName ?? "Unassigned"}`);
  lines.push(`Priority: ${f.priority?.name ?? "None"}`);
  lines.push(`Estimate: ${f.timetracking?.originalEstimate ?? "—"}`);
  if (opts.sprintRange) {
    lines.push(`Sprint: ${opts.sprintRange}`);
  }
  lines.push(`Reporter: ${f.reporter?.emailAddress ?? f.reporter?.displayName ?? "Unknown"}`);
  lines.push(`Created: ${formatDate(f.created)}`);
  lines.push("");

  lines.push("---");
  lines.push("");

  const description = adfToMarkdown(f.description);
  lines.push(description || "_No description_");
  lines.push("");

  if (opts.includeComments && f.comment && f.comment.comments.length > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Comments");
    lines.push("");
    for (const comment of f.comment.comments) {
      lines.push(...formatComment(comment));
    }
  }

  return lines.join("\n");
}

function formatComment(comment: JiraComment): string[] {
  const author = comment.author.displayName;
  const date = formatDate(comment.created);
  const body = adfToMarkdown(comment.body);
  const lines: string[] = [];

  lines.push(`> **${author}** — ${date}`);
  for (const line of body.split("\n")) {
    lines.push(`> ${line}`);
  }
  lines.push("");
  return lines;
}

/**
 * Parses a Markdown issue file back into structured fields.
 * Format:
 *   # KEY - Summary
 *
 *   Field: value
 *   ...
 *
 *   ---
 *
 *   Description body
 *
 *   ---
 *   (optional comments)
 */
export function parseIssueFile(content: string): ParsedIssueFile {
  const lines = content.split("\n");

  // Parse title line
  const titleLine = lines[0] ?? "";
  const titleMatch = titleLine.match(/^#\s+(\S+)\s+-\s+(.+)$/);
  if (!titleMatch) {
    throw new Error(`Invalid issue file: first line must be "# KEY - Summary"`);
  }
  const key = titleMatch[1]!;
  const summary = titleMatch[2]!.trim();

  // Find first --- separator
  const firstSep = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (firstSep === -1) {
    throw new Error(`Invalid issue file: missing --- separator after header`);
  }

  // Parse header block (lines between title and first ---)
  const headerLines = lines.slice(1, firstSep).filter(l => l.trim() !== "");
  const fields: ParsedIssueFile["fields"] = {};
  for (const line of headerLines) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const fieldName = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (fieldName === "status") fields.status = value;
    else if (fieldName === "assignee") fields.assignee = value;
    else if (fieldName === "priority") fields.priority = value;
    else if (fieldName === "estimate") fields.estimate = value;
    // sprint, reporter, created — read-only, ignored
  }

  // Find second --- separator (end of description)
  const secondSep = lines.findIndex((l, i) => i > firstSep + 1 && l.trim() === "---");

  const descLines =
    secondSep !== -1
      ? lines.slice(firstSep + 1, secondSep)
      : lines.slice(firstSep + 1);

  const description = descLines.join("\n").trim();

  return { key, summary, fields, description };
}
