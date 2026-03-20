import * as p from "@clack/prompts";
import pc from "picocolors";
import { createInterface } from "node:readline";
import { loadConfig } from "../../lib/config.ts";
import { getWorklogs, deleteWorklog, createWorklog } from "../../lib/tempo.ts";
import { parseDuration, formatDuration } from "../../lib/duration.ts";
import type { WorklogEntry } from "../../lib/types.ts";

function resolveDate(input: string | undefined): string {
  if (!input || input === "today") {
    return new Date().toISOString().slice(0, 10);
  }
  if (input === "yesterday") {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  // Validate YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
  throw new Error(`Invalid date "${input}". Use YYYY-MM-DD, "today", or "yesterday".`);
}

/**
 * Parses a worklog entry line like "3h Reviewed PR for ABC-123"
 * or "2h30m code review" into { issueKey, durationSeconds, description }.
 *
 * Issue key is optional in the description — it's extracted if present.
 */
function parseEntry(line: string): WorklogEntry {
  const m = line.match(/^(\S+)\s+(.+)$/);
  if (!m) throw new Error(`Cannot parse: "${line}". Format: <duration> <issue-key> <description>`);

  const durationStr = m[1]!;
  const rest = m[2]!.trim();

  const durationSeconds = parseDuration(durationStr);

  // Try to extract issue key (e.g. ABC-123) from the beginning of rest
  const keyMatch = rest.match(/^([A-Z][A-Z0-9]+-\d+)\s*(.*)?$/);
  let issueKey: string;
  let description: string;

  if (keyMatch) {
    issueKey = keyMatch[1]!;
    description = (keyMatch[2] ?? "").trim() || issueKey;
  } else {
    throw new Error(
      `No issue key found in "${rest}". Format: <duration> <ISSUE-KEY> <description>`
    );
  }

  return { issueKey, durationSeconds, description };
}

export async function worklog(dayInput: string | undefined): Promise<void> {
  let date: string;
  try {
    date = resolveDate(dayInput);
  } catch (err) {
    p.log.error(String(err));
    process.exit(1);
  }

  const config = loadConfig();

  // Fetch existing worklogs for the day
  const spinner = p.spinner();
  spinner.start(`Loading worklogs for ${date}…`);
  let existing;
  try {
    existing = await getWorklogs(config, date);
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }

  if (existing.length > 0) {
    const total = existing.reduce((s, w) => s + w.timeSpentSeconds, 0);
    spinner.stop(
      `${existing.length} existing worklog(s) for ${date} (${formatDuration(total)} total) — will be replaced`
    );
  } else {
    spinner.stop(`No existing worklogs for ${date}`);
  }

  // Interactive REPL-style input
  console.log(
    pc.cyan(`\nEnter worklogs for ${pc.bold(date)}. Format: ${pc.dim("<duration> <ISSUE-KEY> [description]")}`)
  );
  console.log(pc.dim(`Type DONE or press Ctrl+C to finish.\n`));

  const entries: WorklogEntry[] = [];

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  await new Promise<void>((resolve) => {
    const prompt = () => {
      rl.question(pc.dim("> "), (line) => {
        const trimmed = line.trim();

        if (trimmed === "" ) {
          prompt();
          return;
        }

        if (trimmed.toUpperCase() === "DONE") {
          rl.close();
          resolve();
          return;
        }

        try {
          const entry = parseEntry(trimmed);
          entries.push(entry);
          console.log(
            pc.green(`  + ${formatDuration(entry.durationSeconds)} → ${entry.issueKey}: ${entry.description}`)
          );
        } catch (err) {
          console.log(pc.red(`  ✗ ${String(err)}`));
        }

        prompt();
      });
    };

    rl.on("close", () => resolve());
    prompt();
  });

  if (entries.length === 0) {
    p.log.warn("No entries — nothing submitted.");
    return;
  }

  const totalSeconds = entries.reduce((s, e) => s + e.durationSeconds, 0);
  console.log(
    `\n${pc.bold("Summary:")} ${entries.length} entry(s), ${formatDuration(totalSeconds)} total`
  );

  const confirmed = await p.confirm({
    message: `Replace all worklogs for ${date} with ${entries.length} new entry(s)?`,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled.");
    return;
  }

  const applySpinner = p.spinner();
  applySpinner.start("Applying…");

  try {
    // Delete existing
    for (const w of existing) {
      await deleteWorklog(config, w.tempoWorklogId);
    }

    // Create new
    for (const entry of entries) {
      await createWorklog(config, {
        issueKey: entry.issueKey,
        timeSpentSeconds: entry.durationSeconds,
        startDate: date,
        startTime: "09:00:00",
        description: entry.description,
      });
    }

    applySpinner.stop(
      pc.green(`✓ Replaced ${existing.length} worklog(s) with ${entries.length} new entry(s) for ${date}`)
    );
  } catch (err) {
    applySpinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }
}
