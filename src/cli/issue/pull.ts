import * as p from "@clack/prompts";
import pc from "picocolors";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadConfig } from "../../lib/config.ts";
import { getIssue, extractSprint, getSprint } from "../../lib/jira.ts";
import { issueToMarkdown } from "../../lib/format.ts";
import { writeSnapshot, setActiveFile } from "../../lib/snapshot.ts";
import { resolveIssuePath } from "../../lib/projects.ts";

export async function pullIssue(
  key: string,
  filePath: string | undefined,
  opts: { comments?: boolean }
): Promise<void> {
  const config = loadConfig();

  const spinner = p.spinner();
  spinner.start(`Fetching ${key}…`);

  let issue;
  try {
    issue = await getIssue(config, key, opts.comments ?? false);
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }

  const statusCategoryKey = issue.fields.status.statusCategory?.key ?? "";
  const outPath = filePath ? resolve(filePath) : resolveIssuePath(key, statusCategoryKey);

  spinner.stop(`Fetched ${key}`);

  if (existsSync(outPath)) {
    const overwrite = await p.confirm({
      message: `${outPath} already exists. Overwrite?`,
    });
    if (p.isCancel(overwrite) || !overwrite) {
      p.cancel("Cancelled.");
      return;
    }
  }

  let sprintRange: string | undefined;
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

  const markdown = issueToMarkdown(issue, {
    includeComments: opts.comments,
    sprintRange,
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, markdown, "utf-8");
  writeSnapshot(key, markdown);
  setActiveFile(key, outPath);

  p.log.success(pc.green(`✓ Wrote ${outPath}`));
}
