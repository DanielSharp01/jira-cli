import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig } from "../../lib/config.ts";
import { getIssue, extractSprint, getSprint } from "../../lib/jira.ts";
import { adfToMarkdown } from "../../lib/adf.ts";

export async function describeIssue(key: string): Promise<void> {
  const config = loadConfig();

  const spinner = p.spinner();
  spinner.start(`Fetching ${key}…`);

  let issue;
  try {
    issue = await getIssue(config, key);
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }

  let sprintRange: string | null = null;
  const sprintRef = extractSprint(issue);
  if (sprintRef) {
    try {
      const sprint = await getSprint(config, sprintRef.id);
      if (sprint.startDate && sprint.endDate) {
        sprintRange = `${sprint.startDate.slice(0, 10)} – ${sprint.endDate.slice(0, 10)}`;
      }
    } catch {
      // best-effort
    }
  }

  spinner.stop(pc.bold(`${key} — ${issue.fields.summary}`));

  const f = issue.fields;
  const description = adfToMarkdown(f.description);

  const rows: [string, string][] = [
    ["Summary",  f.summary],
    ["Type",     f.issuetype.name],
    ["Status",   pc.cyan(f.status.name)],
    ["Assignee", f.assignee?.displayName ?? pc.dim("Unassigned")],
    ["Priority", f.priority?.name ?? "—"],
    ["Estimate", f.timetracking?.originalEstimate ?? "—"],
    ...(sprintRange ? [["Sprint", sprintRange] as [string, string]] : []),
    ["Reporter", f.reporter?.displayName ?? "—"],
    ["Created",  f.created.slice(0, 10)],
  ];

  const labelWidth = Math.max(...rows.map(([l]) => l.length));

  console.log();
  for (const [label, value] of rows) {
    if (label === "Summary") continue;
    console.log(`  ${pc.dim(label.padEnd(labelWidth))}  ${value}`);
  }
  if (description) {
    console.log();
    console.log(pc.dim("  Description"));
    console.log();
    for (const line of description.split("\n")) {
      console.log(`  ${line}`);
    }
  }
  console.log();
}
