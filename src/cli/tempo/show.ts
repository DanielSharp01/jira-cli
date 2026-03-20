import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig } from "../../lib/config.ts";
import { getWorklogsForRange, getWorkingDays } from "../../lib/tempo.ts";
import { getIssueKeysByIds } from "../../lib/jira.ts";
import { parseDateRange } from "../../lib/date-range.ts";
import { formatDuration } from "../../lib/duration.ts";

function dayLabel(dateStr: string): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const d = new Date(dateStr + "T12:00:00");
  return days[d.getDay()]!;
}

export async function showTempo(
  fromArg?: string,
  toArg?: string,
  opts: { file?: string | boolean } = {}
): Promise<void> {
  let range: { from: string; to: string };
  try {
    range = parseDateRange(fromArg, toArg);
  } catch (err) {
    p.log.error(String(err));
    process.exit(1);
  }

  const config = loadConfig();
  const spinner = p.spinner();
  spinner.start(`Loading worklogs ${range.from} → ${range.to}…`);

  let worklogs: TempoWorklog[];
  let workingDays: string[];

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

  const issueIds = [...new Set(worklogs.map(w => w.issue.id))];
  const issueKeys = await getIssueKeysByIds(config, issueIds);

  const byDate = new Map<string, TempoWorklog[]>();
  for (const wl of worklogs) {
    const arr = byDate.get(wl.startDate) ?? [];
    arr.push(wl);
    byDate.set(wl.startDate, arr);
  }

  if (opts.file) {
    const lines: string[] = [];
    for (const date of workingDays) {
      lines.push(`# ${date}`);
      const entries = byDate.get(date) ?? [];
      for (const e of entries) {
        lines.push(`- ${issueKeys.get(e.issue.id) ?? e.issue.id} ${e.description} ${formatDuration(e.timeSpentSeconds)}`);
      }
      lines.push("");
    }
    const output = lines.join("\n");
    if (typeof opts.file === "string") {
      await Bun.write(opts.file, output);
      console.log(`Wrote ${opts.file}`);
    } else {
      console.log(output);
    }
    return;
  }

  for (const date of workingDays) {
    const entries = byDate.get(date) ?? [];
    const total = entries.reduce((s, e) => s + e.timeSpentSeconds, 0);
    const dow = dayLabel(date);

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
