import * as p from "@clack/prompts";
import pc from "picocolors";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../../lib/config.ts";
import { getIssue, searchIssues } from "../../lib/jira.ts";
import { issueToMarkdown } from "../../lib/format.ts";
import { writeSnapshot, setActiveFile } from "../../lib/snapshot.ts";
import { loadProjects, resolveIssuePath } from "../../lib/projects.ts";
import { buildJql, type IssueScope } from "../../lib/jql.ts";

function parseScope(raw: string | undefined): IssueScope | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s === "sprint") return "sprint";
  if (s === "backlog") return "backlog";
  return "all";
}

function issueLabel(key: string, status: string, summary: string): string {
  const truncated = summary.length > 60 ? summary.slice(0, 57) + "…" : summary;
  return `${key}  ${pc.dim(`[${status}]`)}  ${truncated}`;
}

export async function projectPullIssues(
  projectKeyArg: string | undefined,
  scopeArg: string | undefined,
  opts: { from?: string; status?: string }
): Promise<void> {
  const config = loadConfig();
  const projects = loadProjects();

  // Step 1: resolve project key
  let projectKey = projectKeyArg?.toUpperCase();
  if (!projectKey) {
    const keys = Object.keys(projects);
    if (keys.length === 0) {
      p.log.error("No projects configured. Run `jira project workdir` first.");
      process.exit(1);
    }
    const selected = await p.select({
      message: "Select a project:",
      options: keys.map((k) => ({ value: k, label: k })),
    });
    if (p.isCancel(selected)) { p.cancel("Cancelled."); return; }
    projectKey = selected as string;
  }

  // Step 2: validate workingDir
  const projectConfig = projects[projectKey];
  if (!projectConfig?.workingDir) {
    p.log.error(
      `No working directory configured for ${projectKey}. Run \`jira project workdir ${projectKey}\` first.`
    );
    process.exit(1);
  }

  // Step 3: resolve scope
  let scope = parseScope(scopeArg);
  if (scope === undefined) {
    const selected = await p.select({
      message: "Pull issues from:",
      options: [
        { value: "sprint",  label: "Active Sprint" },
        { value: "backlog", label: "Backlog" },
        { value: "all",     label: "All Issues" },
      ],
    });
    if (p.isCancel(selected)) { p.cancel("Cancelled."); return; }
    scope = selected as IssueScope;
  }

  const statusFilter = opts.status ? opts.status.split(",").map((s) => s.trim()) : undefined;
  const jql = buildJql(projectKey, { scope, from: opts.from, status: statusFilter });

  // Step 4: fetch issues
  const spinner = p.spinner();
  spinner.start(`Searching ${projectKey} (${scope})…`);
  let issues;
  try {
    issues = await searchIssues(config, jql);
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }
  spinner.stop(`Found ${issues.length} issues`);

  if (issues.length === 0) {
    p.log.warn("No issues found matching your filters.");
    return;
  }

  // Step 5: multiselect
  const selected = await p.multiselect({
    message: "Select issues to pull:",
    options: issues.map((issue) => ({
      value: issue.key,
      label: issueLabel(issue.key, issue.fields.status.name, issue.fields.summary),
    })),
    required: true,
  });
  if (p.isCancel(selected)) { p.cancel("Cancelled."); return; }
  const selectedKeys = selected as string[];

  // Step 6: pull each issue (force — no overwrite prompt)
  spinner.start(`Pulling ${selectedKeys.length} issues…`);
  let pulled = 0;
  const errors: string[] = [];

  for (const key of selectedKeys) {
    try {
      const issue = await getIssue(config, key, false);
      const markdown = issueToMarkdown(issue, {});
      const statusCategoryKey = issue.fields.status.statusCategory?.key ?? "";
      const outPath = resolveIssuePath(key, statusCategoryKey);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, markdown, "utf-8");
      writeSnapshot(key, markdown);
      setActiveFile(key, outPath);
      pulled++;
      spinner.message(`Pulled ${pulled}/${selectedKeys.length}: ${key}`);
    } catch (err) {
      errors.push(`${key}: ${String(err)}`);
    }
  }

  spinner.stop(pc.green(`✓ Pulled ${pulled} of ${selectedKeys.length} issues`));

  for (const e of errors) {
    p.log.error(e);
  }
}
