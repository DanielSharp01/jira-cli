import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig } from "../lib/config.ts";
import { getProjects, searchIssues } from "../lib/jira.ts";
import { buildJql, type IssueScope } from "../lib/jql.ts";
import { loadProjects } from "../lib/projects.ts";
import { describeIssue } from "./issue/describe.ts";
import { pullIssue } from "./issue/pull.ts";
import { commentOnIssue } from "./issue/comment.ts";
import { setStatus } from "./issue/status.ts";

function parseScope(raw: string | undefined): IssueScope | undefined {
  if (!raw) return undefined;
  const s = raw.toLowerCase();
  if (s === "sprint") return "sprint";
  if (s === "backlog") return "backlog";
  return "all";
}

function issueLabel(key: string, type: string, status: string, summary: string): string {
  const truncated = summary.length > 60 ? `${summary.slice(0, 57)}…` : summary;
  return `${key}  ${pc.dim(`[${type}]`)}  ${pc.dim(`[${status}]`)}  ${truncated}`;
}

export async function exploreIssues(
  projectKeyArg: string | undefined,
  scopeArg: string | undefined,
  opts: { from?: string; status?: string }
): Promise<void> {
  const config = loadConfig();
  const statusFilter = opts.status ? opts.status.split(",").map((s) => s.trim()) : undefined;

  // Outer loop: project selection
  while (true) {
    let projectKey = projectKeyArg?.toUpperCase();
    if (!projectKey) {
      const spinner = p.spinner();
      spinner.start("Loading projects…");
      let projects;
      try {
        projects = await getProjects(config);
      } catch (err) {
        spinner.stop("Failed");
        p.log.error(String(err));
        process.exit(1);
      }
      spinner.stop(`Found ${projects.length} projects`);

      if (projects.length === 0) {
        p.log.error("No accessible JIRA projects found.");
        process.exit(1);
      }

      const selected = await p.select({
        message: "Select a project:",
        options: projects.map((pr) => ({
          value: pr.key,
          label: `${pr.key} — ${pr.name}`,
        })),
      });
      if (p.isCancel(selected)) { p.cancel("Bye."); return; }
      projectKey = selected as string;
    }

    // Middle loop: scope selection
    while (true) {
      let scope = parseScope(scopeArg);
      if (scope === undefined) {
        const selected = await p.select({
          message: "Show issues from:",
          options: [
            { value: "sprint",   label: "Active Sprint" },
            { value: "backlog",  label: "Backlog" },
            { value: "all",      label: "All Issues" },
            ...(projectKeyArg ? [] : [{ value: "__back__", label: pc.dim("← Change project") }]),
          ],
        });
        if (p.isCancel(selected)) { p.cancel("Bye."); return; }
        if (selected === "__back__") break;
        scope = selected as IssueScope;
      }

      const jql = buildJql(projectKey, { scope, from: opts.from, status: statusFilter });

      // Fetch issues
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
        if (scopeArg) return;
        // let them go back to scope picker
      } else {
        // Inner loop: issue selection
        // "goToProject" = break all the way out to project picker
        let goToProject = false;
        const hasWorkdir = !!loadProjects()[projectKey];
        while (true) {
          const selected = await p.select({
            message: `${projectKey} (${scope}) — pick an issue:`,
            options: issues.map((issue) => ({
              value: issue.key,
              label: issueLabel(issue.key, issue.fields.issuetype.name, issue.fields.status.name, issue.fields.summary),
            })),
          });
          if (p.isCancel(selected)) { p.cancel("Bye."); return; }

          const issueKey = selected as string;
          await describeIssue(issueKey);

          // Back options depend on what was fixed by CLI args
          const canChangeScope   = !scopeArg;
          const canChangeProject = !projectKeyArg && (!!scopeArg || true); // always if project wasn't fixed

          // "What next?" loop — stays on this issue until "Pick another" or back
          let goToScope = false;
          while (true) {
            const next = await p.select({
              message: "What next?",
              options: [
                { value: "again",     label: "Pick another issue" },
                { value: "comments",  label: "Comments" },
                { value: "setstatus", label: "Set status" },
                ...(hasWorkdir ? [{ value: "pull", label: "Pull to file" }] : []),
                ...(canChangeScope   ? [{ value: "scope",   label: "← Change scope" }]   : []),
                ...(canChangeProject ? [{ value: "project", label: "← Change project" }] : []),
                { value: "exit",      label: "Exit" },
              ],
            });
            if (p.isCancel(next) || next === "exit") { p.cancel("Bye."); return; }
            if (next === "scope")   { goToScope = true; break; }
            if (next === "project") { goToProject = true; break; }
            if (next === "again") break;
            if (next === "comments")  { await commentOnIssue(issueKey); continue; }
            if (next === "setstatus") { await setStatus(issueKey); continue; }
            if (next === "pull")      { await pullIssue(issueKey, undefined, {}); continue; }
          }
          if (goToScope || goToProject) break;
        }
        // "goToScope" → just break out of issue loop, middle loop will re-show scope picker
        if (goToProject) break;
      }

      if (scopeArg) {
        // scope was fixed by arg — only option was "change project"
        if (projectKeyArg) return;
        break;
      }
      // otherwise loop back to scope picker
    }

    if (projectKeyArg) return;
    // otherwise loop back to project picker
  }
}
