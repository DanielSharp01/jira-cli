import * as p from "@clack/prompts";
import pc from "picocolors";
import { createInterface } from "node:readline";
import { loadConfig } from "../../lib/config.ts";
import { getWorklogsForRange, getWorkingDays, deleteWorklog, createWorklog } from "../../lib/tempo.ts";
import { getIssueKeysByIds, getIssueIdsByKeys } from "../../lib/jira.ts";
import { parseDateRange } from "../../lib/date-range.ts";
import { parseDuration, formatDuration } from "../../lib/duration.ts";
import type { TempoWorklog } from "../../lib/types.ts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayLabel(dateStr: string): string {
  return DAYS[new Date(`${dateStr}T12:00:00`).getDay()]!;
}

// ---------------------------------------------------------------------------
// Entry parsing
// ---------------------------------------------------------------------------

export interface WorklogEntry {
  issueKey: string;
  description: string;
  durationSeconds: number;
}

const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const DUR_RE = /^(?:\d+(?:\.\d+)?h)?(?:\d+(?:\.\d+)?m)?$/;

function isDurationToken(t: string): boolean {
  return DUR_RE.test(t) && t.length > 0 && t !== "h" && t !== "m";
}

/** Parse a worklog entry line in any order: KEY description duration.
 *  Dashes are allowed as separators between parts.
 *  If multiple key-like tokens exist, the FIRST is used as the issue key.
 *  Duration must be unambiguous (exactly one token matching duration format).
 */
export function parseEntryLine(line: string): WorklogEntry {
  // Strip leading dashes/spaces
  const stripped = line.replace(/^[\s\-–—]+/, "");

  // Split by: space-surrounded dashes, 2+ consecutive dashes (unambiguous separator
  // since issue keys only use single dashes), or plain whitespace.
  const tokens = stripped
    .split(/\s+[-–—]+\s+|\s*-{2,}\s*|\s+/)
    .map(t => t.replace(/^[-–—]+/, "").replace(/[-–—]+$/, ""))
    .filter(t => t.length > 0);

  const keyTokens = tokens.filter(t => KEY_RE.test(t));
  const durTokens = tokens.filter(t => isDurationToken(t));

  if (keyTokens.length === 0) {
    throw new Error(`Cannot parse: "${line}" — no issue key found`);
  }
  if (durTokens.length === 0) {
    throw new Error(`Cannot parse: "${line}" — no duration found`);
  }

  // First match wins for both key and duration; extras go into description
  const issueKey = keyTokens[0]!;
  const durationStr = durTokens[0]!;
  const durationSeconds = parseDuration(durationStr);

  // Everything except the first key token and the first duration token → description
  let keyUsed = false;
  let durUsed = false;
  const descTokens = tokens.filter(t => {
    if (!keyUsed && t === issueKey) { keyUsed = true; return false; }
    if (!durUsed && t === durationStr) { durUsed = true; return false; }
    return true;
  });

  const description = descTokens.join(" ");
  if (!description) {
    throw new Error(`Cannot parse: "${line}" — no description found`);
  }

  return { issueKey, description, durationSeconds };
}

// ---------------------------------------------------------------------------
// File parsing
// ---------------------------------------------------------------------------

function parseMarkdownFile(content: string): Map<string, WorklogEntry[]> {
  const result = new Map<string, WorklogEntry[]>();
  let currentDate: string | null = null;

  for (const line of content.split("\n")) {
    // Match headers like "# 2026-03-02" or "# 2026-03-02 (Monday)"
    const headerMatch = line.match(/^#\s+(\d{4}-\d{2}-\d{2})/);
    if (headerMatch) {
      currentDate = headerMatch[1]!;
      result.set(currentDate, []);
      continue;
    }
    if (currentDate && line.match(/^[\s\-–—]*[A-Z]/)) {
      try {
        result.get(currentDate)!.push(parseEntryLine(line));
      } catch {
        // skip malformed lines silently
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Interactive entry collection
// ---------------------------------------------------------------------------

async function collectInteractiveEntries(
  date: string,
  totalExistingSeconds: number,
  loggedThreshold: number,
  existingSummary: string
): Promise<WorklogEntry[]> {
  const loggedStr = formatDuration(totalExistingSeconds);
  const threshStr = formatDuration(loggedThreshold);

  console.log(pc.dim(`\n──────────────────────────────────────`));
  if (totalExistingSeconds > 0) {
    console.log(` ${pc.bold(date)} (logged: ${loggedStr}/${threshStr})`);
    console.log(` Existing: ${existingSummary}`);
  } else {
    console.log(` ${pc.bold(date)}`);
  }
  console.log(pc.dim(`──────────────────────────────────────`));
  console.log(pc.dim(`  [Issue key   task description   duration]`));
  console.log(pc.dim(`  Enter entries. Blank line = done.`));

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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type DayAction = "replace" | "append" | "leave" | "skip";

interface DayPlan {
  date: string;
  existing: TempoWorklog[];
  action: DayAction;
  entries: WorklogEntry[];
}

export async function logTempo(
  fromArg?: string,
  toArg?: string,
  opts: {
    file?: string;
    stdin?: boolean;
    days?: string;
    logged?: string;
    exact?: boolean;
    prompt?: boolean;
  } = {}
): Promise<void> {
  const config = loadConfig();

  if (opts.file && opts.stdin) {
    p.log.error("Cannot use --file and --stdin together.");
    process.exit(1);
  }

  let loggedThreshold: number;
  try {
    loggedThreshold = parseDuration(opts.logged ?? "8h");
  } catch {
    p.log.error(`Invalid --logged value "${opts.logged}"`);
    process.exit(1);
  }

  // Load file/stdin content
  let fileEntries: Map<string, WorklogEntry[]> | null = null;
  if (opts.file || opts.stdin) {
    try {
      const content = opts.file
        ? await Bun.file(opts.file).text()
        : await Bun.stdin.text();
      fileEntries = parseMarkdownFile(content);
    } catch (err) {
      p.log.error(`Failed to read input: ${String(err)}`);
      process.exit(1);
    }
  }

  // Determine if a date range was explicitly provided
  const hasExplicitRange = !!(fromArg || toArg);

  // Validate --exact/--prompt usage with file mode
  if (fileEntries && !hasExplicitRange && (opts.exact || opts.prompt)) {
    p.log.error("--exact and --prompt require an explicit date range when using --file/--stdin.");
    process.exit(1);
  }

  // Implied defaults when file + explicit range
  const useExact = fileEntries && hasExplicitRange ? (opts.exact ?? true) : (opts.exact ?? false);
  const usePrompt = fileEntries && hasExplicitRange ? (opts.prompt ?? true) : (opts.prompt ?? false);

  // Resolve date range
  let range: { from: string; to: string };
  if (!hasExplicitRange && fileEntries) {
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

  // Apply --days filter for interactive mode (and --exact validation)
  const daysFilter = opts.days ?? "unlogged";
  const today = new Date().toISOString().slice(0, 10);

  const filteredWorkingDays = workingDays.filter(date => {
    if (date > today) return false;
    const total = (existingByDate.get(date) ?? []).reduce((s, w) => s + w.timeSpentSeconds, 0);
    if (daysFilter === "unlogged") return total < loggedThreshold;
    if (daysFilter === "no-logs") return total === 0;
    return true; // "working" or "all"
  });

  // File mode iterates ALL working days in range (--days is ignored per spec).
  // Interactive mode uses the filtered list.
  const workingDaysInRange = workingDays.filter(d => d <= today);

  // --exact validation: compare file dates against ALL working days (not filtered)
  if (fileEntries && useExact) {
    const fileDates = new Set(fileEntries.keys());
    const expectedDates = new Set(workingDaysInRange);
    const extra = [...fileDates].filter(d => !expectedDates.has(d));
    const missing = [...expectedDates].filter(d => !fileDates.has(d) && !usePrompt);
    if (extra.length > 0) {
      p.log.error(`--exact: file contains days outside the working-day range: ${extra.join(", ")}`);
      process.exit(1);
    }
    if (missing.length > 0) {
      p.log.error(`--exact: file is missing working days: ${missing.join(", ")}`);
      process.exit(1);
    }
  }

  // Build day plans
  const dayPlans: DayPlan[] = [];

  // Determine which days to iterate
  const daysToProcess = fileEntries
    ? workingDaysInRange  // file mode: all working days, --days ignored
    : (daysFilter === "all"
        ? (() => {
            const all: string[] = [];
            const cur = new Date(`${range.from}T12:00:00`);
            const end = new Date(`${range.to}T12:00:00`);
            while (cur <= end) {
              const d = cur.toISOString().slice(0, 10);
              if (d <= today) all.push(d);
              cur.setDate(cur.getDate() + 1);
            }
            return all;
          })()
        : filteredWorkingDays);

  for (const date of daysToProcess) {
    const existing = existingByDate.get(date) ?? [];
    const totalExistingSeconds = existing.reduce((s, w) => s + w.timeSpentSeconds, 0);
    const existingSummary = existing.length > 0
      ? existing.map(w => `${existingIssueKeys.get(w.issue.id) ?? w.issue.id} ${formatDuration(w.timeSpentSeconds)} ${w.description}`).join(", ")
      : "no logs";

    // File mode
    if (fileEntries) {
      const fileDay = fileEntries.get(date);
      if (fileDay === undefined) {
        // Day not in file
        if (usePrompt) {
          const entries = await collectInteractiveEntries(date, totalExistingSeconds, loggedThreshold, existingSummary);
          const action: DayAction = existing.length > 0 ? "replace" : "append";
          dayPlans.push({ date, existing, action, entries });
        }
        // else: skip silently
        continue;
      }
      dayPlans.push({ date, existing, action: "replace", entries: fileDay });
      continue;
    }

    // Interactive mode — handle fully logged days
    if (totalExistingSeconds >= loggedThreshold) {
      // Should only reach here if daysFilter includes them (working/all)
      console.log(`\n  ${pc.bold(date)} (${dayLabel(date)}) — ${pc.yellow(`logged: ${formatDuration(totalExistingSeconds)}/${formatDuration(loggedThreshold)}`)} — ${pc.dim("skipped")}`);
      dayPlans.push({ date, existing, action: "skip", entries: [] });
      continue;
    }

    // Interactive mode — partially or unlogged
    let action: DayAction = "append";
    if (existing.length > 0) {
      const choice = await p.select({
        message: `${pc.bold(date)} (logged: ${formatDuration(totalExistingSeconds)}/${formatDuration(loggedThreshold)})`,
        options: [
          { value: "append", label: "Append — keep existing, add new entries" },
          { value: "replace", label: "Replace — delete existing and log new entries" },
          { value: "leave", label: "Leave — skip this day" },
        ],
      });
      if (p.isCancel(choice)) {
        p.cancel("Cancelled.");
        process.exit(0);
      }
      action = choice as DayAction;
    }

    if (action === "leave") {
      dayPlans.push({ date, existing, action: "leave", entries: [] });
      continue;
    }

    let entries = await collectInteractiveEntries(date, totalExistingSeconds, loggedThreshold, existingSummary);

    // Over/under warning + redo
    const newTotal = entries.reduce((s, e) => s + e.durationSeconds, 0);
    const effectiveTotal = action === "append" ? totalExistingSeconds + newTotal : newTotal;
    if (entries.length > 0 && effectiveTotal !== loggedThreshold) {
      const dir = effectiveTotal < loggedThreshold ? "under" : "over";
      console.log(pc.yellow(`  ⚠  ${date}: ${formatDuration(effectiveTotal)} logged (${dir} ${formatDuration(loggedThreshold)})`));
      const redo = await p.confirm({ message: "Redo this day?" });
      if (!p.isCancel(redo) && redo) {
        entries = await collectInteractiveEntries(date, totalExistingSeconds, loggedThreshold, existingSummary);
      }
    }

    dayPlans.push({ date, existing, action, entries });
  }

  // Summary before confirm
  const daysToApply = dayPlans.filter(plan => plan.action !== "skip" && plan.action !== "leave" && plan.entries.length > 0);

  if (daysToApply.length === 0) {
    console.log(pc.yellow("\nNo entries to apply."));
    return;
  }

  // File mode: batch overwrite confirmation
  if (fileEntries) {
    const overwrites = daysToApply.filter(plan => plan.action === "replace" && plan.existing.length > 0);
    if (overwrites.length > 0) {
      console.log(`\n${pc.bold("The following days have existing logs that would be replaced:")}`);
      for (const plan of overwrites) {
        const total = plan.existing.reduce((s, w) => s + w.timeSpentSeconds, 0);
        console.log(`  ${pc.bold(plan.date)} (logged: ${formatDuration(total)}/${formatDuration(loggedThreshold)})`);
      }

      let confirmed = false;
      while (!confirmed) {
        const choice = await p.select({
          message: "Proceed?",
          options: [
            { value: "yes", label: "Yes — apply all changes" },
            { value: "no", label: "No — cancel" },
            { value: "show", label: "Show — display existing and new entries" },
          ],
        });
        if (p.isCancel(choice) || choice === "no") {
          p.cancel("Cancelled.");
          return;
        }
        if (choice === "yes") {
          confirmed = true;
        } else {
          // Show
          for (const plan of overwrites) {
            const existingLines = plan.existing.map(w =>
              `    existing: ${existingIssueKeys.get(w.issue.id) ?? w.issue.id} ${formatDuration(w.timeSpentSeconds)} ${w.description}`
            );
            const newLines = plan.entries.map(e =>
              `    new:      ${e.issueKey} ${formatDuration(e.durationSeconds)} ${e.description}`
            );
            console.log(`\n  ${pc.bold(plan.date)}:`);
            for (const l of existingLines) console.log(pc.dim(l));
            for (const l of newLines) console.log(pc.green(l));
          }
        }
      }
    }
  }

  // Summary + over/under warnings for file mode
  console.log(`\n${pc.bold("Summary:")}`);
  for (const plan of dayPlans) {
    if (plan.action === "skip") {
      console.log(`  ${pc.dim("↓")} ${plan.date}  skipped`);
    } else if (plan.action === "leave") {
      console.log(`  ${pc.dim("–")} ${plan.date}  left as-is`);
    } else if (plan.entries.length === 0) {
      console.log(`  ${pc.dim("–")} ${plan.date}  no entries`);
    } else {
      const newTotal = plan.entries.reduce((s, e) => s + e.durationSeconds, 0);
      const effectiveTotal = plan.action === "append"
        ? plan.existing.reduce((s, w) => s + w.timeSpentSeconds, 0) + newTotal
        : newTotal;
      const n = plan.entries.length;
      const threshStr = formatDuration(loggedThreshold);
      const totalStr = formatDuration(effectiveTotal);
      const mismatch = effectiveTotal !== loggedThreshold;
      const line = `  ${mismatch ? pc.yellow("⚠") : pc.green("✓")} ${plan.date}  ${totalStr}/${threshStr} (${n} entr${n === 1 ? "y" : "ies"}) — ${plan.action}`;
      console.log(line);
    }
  }

  // Final confirmation (interactive mode / non-file mode, or file without overwrites)
  if (fileEntries) {
    // File mode without overwrites still needs confirmation
    const hasOverwrites = daysToApply.some(plan => plan.action === "replace" && plan.existing.length > 0);
    if (!hasOverwrites) {
      const confirmed = await p.confirm({ message: `Apply ${daysToApply.length} day(s)?` });
      if (p.isCancel(confirmed) || !confirmed) {
        p.cancel("Cancelled.");
        return;
      }
    }
    // if has overwrites, already confirmed above in batch step
  } else {
    // Interactive mode confirmation
    const overwrites = daysToApply.filter(plan => plan.action === "replace" && plan.existing.length > 0).length;
    const confirmMsg = overwrites > 0
      ? `Apply ${daysToApply.length} day(s)? (${overwrites} will overwrite existing logs)`
      : `Apply ${daysToApply.length} day(s)?`;
    const confirmed = await p.confirm({ message: confirmMsg });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Cancelled.");
      return;
    }
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

  console.log(`\n${pc.green("All logs done.")}`);
}
