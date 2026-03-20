import * as p from "@clack/prompts";
import pc from "picocolors";
import { createInterface } from "node:readline";
import { loadConfig } from "../../lib/config.ts";
import { getWorklogsForRange, getWorkingDays, deleteWorklog, createWorklog } from "../../lib/tempo.ts";
import { getIssueKeysByIds, getIssueIdsByKeys } from "../../lib/jira.ts";
import { parseDateRange } from "../../lib/date-range.ts";
import { parseDuration, formatDuration } from "../../lib/duration.ts";
import type { TempoWorklog } from "../../lib/types.ts";

const ENTRY_RE = /^(?:-\s+)?([A-Z][A-Z0-9]+-\d+)\s+(.+?)\s+(\S+)$/;

function dayLabel(dateStr: string): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const d = new Date(`${dateStr}T12:00:00`);
  return days[d.getDay()]!;
}

interface WorklogEntry {
  issueKey: string;
  description: string;
  durationSeconds: number;
}

function parseEntryLine(line: string): WorklogEntry {
  const m = line.match(ENTRY_RE);
  if (!m) {
    throw new Error(`Cannot parse: "${line}". Format: KEY description duration`);
  }
  const [, issueKey, description, durationStr] = m;
  const durationSeconds = parseDuration(durationStr!);
  return { issueKey: issueKey!, description: description!, durationSeconds };
}

function parseMarkdownFile(content: string): Map<string, WorklogEntry[]> {
  const result = new Map<string, WorklogEntry[]>();
  let currentDate: string | null = null;

  for (const line of content.split("\n")) {
    const headerMatch = line.match(/^#\s+(\d{4}-\d{2}-\d{2})/);
    if (headerMatch) {
      currentDate = headerMatch[1]!;
      result.set(currentDate, []);
      continue;
    }
    if (currentDate && line.startsWith("- ")) {
      try {
        result.get(currentDate)!.push(parseEntryLine(line));
      } catch {
        // skip malformed lines silently
      }
    }
  }

  return result;
}

type DayAction = "replace" | "append" | "leave" | "skip";

interface DayPlan {
  date: string;
  existing: TempoWorklog[];
  action: DayAction;
  entries: WorklogEntry[];
}

async function collectInteractiveEntries(date: string, existing: TempoWorklog[], existingIssueKeys: Map<number, string>): Promise<WorklogEntry[]> {
  const existingSummary = existing.length > 0
    ? existing.map(w => `${existingIssueKeys.get(w.issue.id) ?? w.issue.id} ${formatDuration(w.timeSpentSeconds)} ${w.description}`).join(", ")
    : "no logs";

  console.log(pc.dim(`\n──────────────────────────────────────`));
  console.log(` ${pc.bold(date)} (${dayLabel(date)})`);
  console.log(` Existing: ${existingSummary}`);
  console.log(pc.dim(`──────────────────────────────────────`));
  console.log(pc.dim(`Enter entries (KEY description duration). Blank line = done.`));

  const entries: WorklogEntry[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  await new Promise<void>((resolve) => {
    const prompt = () => {
      rl.question(pc.dim("> "), (line) => {
        const trimmed = line.trim();
        if (trimmed === "") {
          rl.close();
          resolve();
          return;
        }
        try {
          const entry = parseEntryLine(trimmed);
          entries.push(entry);
          console.log(pc.green(`  + ${entry.issueKey}: ${entry.description} ${formatDuration(entry.durationSeconds)}`));
        } catch (err) {
          console.log(pc.red(`  ✗ ${String(err)}`));
        }
        prompt();
      });
    };
    rl.on("close", () => resolve());
    prompt();
  });

  return entries;
}

export async function logTempo(
  fromArg?: string,
  toArg?: string,
  opts: { file?: string; skipWhen?: string } = {}
): Promise<void> {
  const config = loadConfig();

  let fileEntries: Map<string, WorklogEntry[]> | null = null;
  if (opts.file) {
    try {
      const content = await Bun.file(opts.file).text();
      fileEntries = parseMarkdownFile(content);
    } catch (err) {
      p.log.error(`Failed to read file: ${String(err)}`);
      process.exit(1);
    }
  }

  let range: { from: string; to: string };
  if (!fromArg && fileEntries) {
    const dates = [...fileEntries.keys()].sort();
    if (dates.length === 0) {
      p.log.error("File has no dated sections.");
      process.exit(1);
    }
    range = { from: dates[0]!, to: dates[dates.length - 1]! };
  } else {
    try {
      range = parseDateRange(fromArg, toArg);
    } catch (err) {
      p.log.error(String(err));
      process.exit(1);
    }
  }

  const spinner = p.spinner();
  spinner.start(`Loading working days and existing logs ${range.from} → ${range.to}…`);

  let existingWorklogs: TempoWorklog[];
  let workingDays: string[];

  try {
    [existingWorklogs, workingDays] = await Promise.all([
      getWorklogsForRange(config, range.from, range.to),
      getWorkingDays(config, range.from, range.to),
    ]);
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }

  spinner.stop(`${workingDays.length} working day(s) in range`);

  const existingIds = [...new Set(existingWorklogs.map(w => w.issue.id))];
  const existingIssueKeys = await getIssueKeysByIds(config, existingIds);

  const existingByDate = new Map<string, TempoWorklog[]>();
  for (const wl of existingWorklogs) {
    const arr = existingByDate.get(wl.startDate) ?? [];
    arr.push(wl);
    existingByDate.set(wl.startDate, arr);
  }

  // Build day plans — for file mode: pre-flight then assign; for interactive: handle each day fully in order
  const dayPlans: DayPlan[] = [];

  for (const date of workingDays) {
    const existing = existingByDate.get(date) ?? [];
    const totalExistingSeconds = existing.reduce((s, w) => s + w.timeSpentSeconds, 0);

    if (opts.skipWhen === "8h" && totalExistingSeconds >= 28_800) {
      dayPlans.push({ date, existing, action: "skip", entries: [] });
      continue;
    }
    if (opts.skipWhen === "any" && existing.length > 0) {
      dayPlans.push({ date, existing, action: "skip", entries: [] });
      continue;
    }

    let action: DayAction = "append";
    if (fileEntries) {
      action = "replace";
    } else if (existing.length > 0) {
      const existingSummary = existing.map(w => `${existingIssueKeys.get(w.issue.id) ?? w.issue.id} ${formatDuration(w.timeSpentSeconds)} ${w.description}`).join(", ");
      console.log(`\n  ${pc.bold(date)} (${dayLabel(date)}) — Existing: ${existingSummary}`);

      const choice = await p.select({
        message: "This day has existing logs",
        options: [
          { value: "replace", label: "Replace — delete existing and log new entries" },
          { value: "append", label: "Append — keep existing, add new entries" },
          { value: "leave", label: "Leave — skip this day" },
        ],
      });

      if (p.isCancel(choice)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }

      action = choice as DayAction;
    }

    let entries: WorklogEntry[] = [];
    if (action !== "leave") {
      entries = fileEntries ? (fileEntries.get(date) ?? []) : await collectInteractiveEntries(date, existing, existingIssueKeys);
    }

    dayPlans.push({ date, existing, action, entries });
  }

  // Summary before confirm
  const daysToApply = dayPlans.filter(plan => plan.action !== "skip" && plan.action !== "leave" && plan.entries.length > 0);

  if (daysToApply.length === 0) {
    console.log(pc.yellow("\nNo entries to apply."));
    return;
  }

  console.log(`\n${pc.bold("Summary:")}`);
  for (const plan of dayPlans) {
    if (plan.action === "skip") {
      console.log(`  ${pc.dim("↓")} ${plan.date}  skipped`);
    } else if (plan.action === "leave") {
      console.log(`  ${pc.dim("–")} ${plan.date}  left as-is`);
    } else if (plan.entries.length === 0) {
      console.log(`  ${pc.dim("–")} ${plan.date}  no entries`);
    } else {
      const total = plan.entries.reduce((s, e) => s + e.durationSeconds, 0);
      const n = plan.entries.length;
      console.log(`  ${pc.green("✓")} ${plan.date}  ${formatDuration(total)} (${n} entr${n === 1 ? "y" : "ies"}) — ${plan.action}`);
    }
  }

  const overwrites = daysToApply.filter(p => p.action === "replace" && p.existing.length > 0).length;
  const confirmMsg = overwrites > 0
    ? `Apply ${daysToApply.length} day(s)? (${overwrites} will overwrite existing logs)`
    : `Apply ${daysToApply.length} day(s)?`;
  const confirmed = await p.confirm({ message: confirmMsg });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled.");
    return;
  }

  // Resolve issue keys → IDs for all entries
  const allEntryKeys = [...new Set(daysToApply.flatMap(plan => plan.entries.map(e => e.issueKey)))];
  let entryIssueIds: Map<string, number>;
  try {
    entryIssueIds = await getIssueIdsByKeys(config, allEntryKeys);
  } catch (err) {
    p.log.error(`Failed to resolve issue IDs: ${String(err)}`);
    process.exit(1);
  }

  const unresolved = allEntryKeys.filter(k => !entryIssueIds.get(k));
  if (unresolved.length > 0) {
    p.log.error(`Could not resolve Jira IDs for: ${unresolved.join(", ")}`);
    process.exit(1);
  }

  // Apply
  const applySpinner = p.spinner();
  applySpinner.start("Applying…");

  const results: Array<{ date: string; status: "logged" | "skipped" | "empty"; seconds: number; count: number }> = [];

  try {
    for (const plan of dayPlans) {
      if (plan.action === "skip") {
        results.push({ date: plan.date, status: "skipped", seconds: 0, count: 0 });
        continue;
      }
      if (plan.action === "leave" || plan.entries.length === 0) {
        results.push({ date: plan.date, status: "empty", seconds: 0, count: 0 });
        continue;
      }

      if (plan.action === "replace") {
        for (const wl of plan.existing) {
          await deleteWorklog(config, wl.tempoWorklogId);
        }
      }

      // Start after existing logs end (append), or at 09:00 (replace/fresh)
      let cursorSeconds = 9 * 3600;
      if (plan.action === "append" && plan.existing.length > 0) {
        const lastEnd = Math.max(...plan.existing.map(w => {
          const [hh, mm, ss] = w.startTime.split(":").map(Number);
          return hh! * 3600 + mm! * 60 + ss! + w.timeSpentSeconds;
        }));
        cursorSeconds = lastEnd;
      }

      for (const entry of plan.entries) {
        const issueId = entryIssueIds.get(entry.issueKey);
        if (!issueId) {
          applySpinner.stop("");
          p.log.warn(`Could not resolve issue ID for ${entry.issueKey} — skipping.`);
          applySpinner.start("Applying…");
          continue;
        }
        const hh = String(Math.floor(cursorSeconds / 3600)).padStart(2, "0");
        const mm = String(Math.floor((cursorSeconds % 3600) / 60)).padStart(2, "0");
        const ss = String(cursorSeconds % 60).padStart(2, "0");
        await createWorklog(config, {
          issueId,
          timeSpentSeconds: entry.durationSeconds,
          startDate: plan.date,
          startTime: `${hh}:${mm}:${ss}`,
          description: entry.description,
        });
        cursorSeconds += entry.durationSeconds;
      }

      const total = plan.entries.reduce((s, e) => s + e.durationSeconds, 0);
      results.push({ date: plan.date, status: "logged", seconds: total, count: plan.entries.length });
    }

    applySpinner.stop("Done");
  } catch (err) {
    applySpinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }

  // Final output
  console.log();
  for (const r of results) {
    if (r.status === "logged") {
      const n = r.count;
      console.log(`${pc.green("✓")}  ${r.date}  ${formatDuration(r.seconds)} logged  (${n} entr${n === 1 ? "y" : "ies"})`);
    } else if (r.status === "skipped") {
      console.log(`${pc.dim("↓")}  ${r.date}  skipped`);
    } else {
      console.log(`${pc.dim("–")}  ${r.date}  no entries (left empty)`);
    }
  }

  // File mode: note working days with no file entries (and not skipped)
  if (fileEntries) {
    const missingDays = workingDays.filter(date => {
      const plan = dayPlans.find(pl => pl.date === date)!;
      return plan.action !== "skip" && (fileEntries!.get(date)?.length ?? 0) === 0;
    });
    if (missingDays.length > 0) {
      console.log(`\n${pc.yellow(`Note: ${missingDays.length} working day(s) had no entries in the file:`)}`);
      console.log(`  ${missingDays.join(", ")}`);
    }
  }

  console.log(`\n${pc.green("All logs done.")}`);
}
