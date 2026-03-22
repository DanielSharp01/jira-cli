import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig } from "../../lib/config.ts";
import { getWorklogsForRange, getWorkingDays } from "../../lib/tempo.ts";
import { getIssueKeysByIds } from "../../lib/jira.ts";
import { parseDateRange } from "../../lib/date-range.ts";
import { parseDuration, formatDuration } from "../../lib/duration.ts";
import type { TempoWorklog } from "../../lib/types.ts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayLabel(dateStr: string): string {
  return DAYS[new Date(`${dateStr}T12:00:00`).getDay()]!;
}

function allCalendarDays(from: string, to: string): string[] {
  const days: string[] = [];
  const cur = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

export async function showTempo(
  fromArg?: string,
  toArg?: string,
  opts: {
    file?: string;
    stdout?: boolean;
    days?: string;
    logged?: string;
    short?: boolean;
  } = {}
): Promise<void> {
  let range: { from: string; to: string };
  try {
    range = parseDateRange(fromArg, toArg);
  } catch (err) {
    p.log.error(String(err));
    process.exit(1);
  }

  let loggedThreshold: number;
  try {
    loggedThreshold = parseDuration(opts.logged ?? "8h");
  } catch {
    p.log.error(`Invalid --logged value "${opts.logged}"`);
    process.exit(1);
  }

  const config = loadConfig();
  const quiet = opts.stdout;

  let worklogs: TempoWorklog[];
  let workingDays: string[];

  if (quiet) {
    try {
      [worklogs, workingDays] = await Promise.all([
        getWorklogsForRange(config, range.from, range.to),
        getWorkingDays(config, range.from, range.to),
      ]);
    } catch (err) {
      process.stderr.write(`Error: ${err}\n`);
      process.exit(1);
    }
  } else {
    const spinner = p.spinner();
    spinner.start(`Loading worklogs ${range.from} → ${range.to}…`);
    try {
      [worklogs, workingDays] = await Promise.all([
        getWorklogsForRange(config, range.from, range.to),
        getWorkingDays(config, range.from, range.to),
      ]);
    } catch (err) {
      spinner.stop("Failed");
      p.log.error(String(err));
      process.exit(1);
    }
    spinner.stop(`Loaded ${worklogs.length} worklog(s) across ${workingDays.length} working day(s)`);
  }

  const issueIds = [...new Set(worklogs.map(w => w.issue.id))];
  const issueKeys = await getIssueKeysByIds(config, issueIds);

  const byDate = new Map<string, TempoWorklog[]>();
  for (const wl of worklogs) {
    const arr = byDate.get(wl.startDate) ?? [];
    arr.push(wl);
    byDate.set(wl.startDate, arr);
  }

  // Build candidate day list based on --days filter
  const daysFilter = opts.days ?? "working";
  const candidateDays = daysFilter === "all" ? allCalendarDays(range.from, range.to) : workingDays;

  const today = new Date().toISOString().slice(0, 10);

  const filteredDays = candidateDays.filter(date => {
    const entries = byDate.get(date) ?? [];
    const total = entries.reduce((s, e) => s + e.timeSpentSeconds, 0);

    if (daysFilter === "unlogged") return total < loggedThreshold;
    if (daysFilter === "no-logs") return total === 0;
    return true; // "all" or "working"
  }).filter(date => date <= today); // never show future days

  if (opts.file || opts.stdout) {
    const lines: string[] = [];
    for (const date of filteredDays) {
      lines.push(`# ${date} (${dayLabel(date)})`);
      const entries = byDate.get(date) ?? [];
      for (const e of entries) {
        lines.push(`- ${issueKeys.get(e.issue.id) ?? e.issue.id} ${e.description} ${formatDuration(e.timeSpentSeconds)}`);
      }
      lines.push("");
    }
    const output = lines.join("\n");
    if (opts.file) {
      await Bun.write(opts.file, output);
      console.log(`Wrote ${opts.file}`);
    } else {
      process.stdout.write(output);
    }
    return;
  }

  for (const date of filteredDays) {
    const entries = byDate.get(date) ?? [];
    const total = entries.reduce((s, e) => s + e.timeSpentSeconds, 0);
    const dow = dayLabel(date);

    if (opts.short) {
      const totalFmt = total === 0 ? "0h" : formatDuration(total);
      const threshFmt = formatDuration(loggedThreshold);
      console.log(`${date} (${dow}): ${totalFmt}/${threshFmt}`);
    } else {
      if (entries.length === 0) {
        console.log(`${pc.bold(date)} (${dow}) — ${pc.dim("0h  [no logs]")}`);
      } else {
        console.log(`${pc.bold(date)} (${dow}) — ${pc.green(formatDuration(total))}`);
        for (const e of entries) {
          const dur = formatDuration(e.timeSpentSeconds).padEnd(6);
          console.log(`  ${pc.cyan((issueKeys.get(e.issue.id) ?? String(e.issue.id)).padEnd(12))} ${dur}  ${e.description}`);
        }
      }
      console.log();
    }
  }
}
