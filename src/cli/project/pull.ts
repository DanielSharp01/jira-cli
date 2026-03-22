import * as p from "@clack/prompts";
import pc from "picocolors";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "../../lib/config.ts";
import { getIssue, searchIssues, getProjectStatuses, getIssueTypes } from "../../lib/jira.ts";
import { issueToMarkdown } from "../../lib/format.ts";
import { writeSnapshot, setActiveFile } from "../../lib/snapshot.ts";
import { loadProjects, resolveIssuePath } from "../../lib/projects.ts";
import { buildJql, type JqlFilters } from "../../lib/jql.ts";
import { applyEstimatedParentFilter } from "../../lib/estimated.ts";
import { runListPicker } from "../../lib/tui.ts";
import { pickScope, pickMultiWithMode } from "../filters.ts";
import type { JiraIssue } from "../../lib/types.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectPullOpts {
  from?: string;
  to?: string;
  fromKey?: number;
  toKey?: number;
  status?: string;
  type?: string;
  estimated?: string;
  name?: string;
  description?: string;
  pick?: boolean;
}

// ---------------------------------------------------------------------------
// Issue label helper
// ---------------------------------------------------------------------------

function issueLabel(key: string, status: string, summary: string): string {
  const truncated = summary.length > 60 ? `${summary.slice(0, 57)}…` : summary;
  return `${key}  ${pc.dim(`[${status}]`)}  ${truncated}`;
}

// ---------------------------------------------------------------------------
// Pull helper
// ---------------------------------------------------------------------------

async function pullIssues(
  config: ReturnType<typeof loadConfig>,
  keys: string[]
): Promise<void> {
  const spinner = p.spinner();
  spinner.start(`Pulling ${keys.length} issue(s)…`);
  let pulled = 0;
  const errors: string[] = [];

  for (const key of keys) {
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
      spinner.message(`Pulled ${pulled}/${keys.length}: ${key}`);
    } catch (err) {
      errors.push(`${key}: ${String(err)}`);
    }
  }

  spinner.stop(pc.green(`✓ Pulled ${pulled} of ${keys.length} issues`));
  for (const e of errors) p.log.error(e);
}

// ---------------------------------------------------------------------------
// Filter hint helpers
// ---------------------------------------------------------------------------

function scopeHint(scope: string | undefined): string {
  return scope ? `  ${pc.dim(`(${scope})`)}` : "";
}

function listHint(values: string[] | undefined): string {
  if (!values || values.length === 0) return "";
  return `  ${pc.dim(values.join(", "))}`;
}

function strHint(value: string | undefined): string {
  return value ? `  ${pc.dim(value)}` : "";
}

// ---------------------------------------------------------------------------
// Fetch issues
// ---------------------------------------------------------------------------

const SEARCH_CAP = 500;

async function fetchWithFilters(
  config: ReturnType<typeof loadConfig>,
  projectKey: string,
  filters: JqlFilters
): Promise<{ issues: JiraIssue[]; hasMore: boolean }> {
  const jql = buildJql(projectKey, filters);
  const spinner = p.spinner();
  spinner.start(`Searching ${projectKey}…`);
  let issues: JiraIssue[];
  try {
    issues = await searchIssues(config, jql, SEARCH_CAP + 1);
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }
  const hasMore = issues.length > SEARCH_CAP;
  if (hasMore) issues = issues.slice(0, SEARCH_CAP);
  if (filters.estimated === "parent") {
    issues = await applyEstimatedParentFilter(config, issues);
  }
  spinner.stop(`Found ${issues.length}${hasMore ? "+" : ""} issue(s)`);
  return { issues, hasMore };
}

// ---------------------------------------------------------------------------
// Interactive filter loop (used when --pick or no scopeArg)
// ---------------------------------------------------------------------------

async function runFilterLoop(
  config: ReturnType<typeof loadConfig>,
  projectKey: string,
  initial: JqlFilters,
  pick: boolean
): Promise<JiraIssue[] | null> {
  const filters: JqlFilters = { ...initial };

  while (true) {
    const searchLabel = pick ? "→ Select issues" : "→ Pull issues";
    const field = await p.select({
      message: "Filters:",
      options: [
        { value: "__search__", label: searchLabel },
        { value: "scope",      label: `Scope / sprint${scopeHint(filters.scope)}` },
        { value: "status",     label: `Status${listHint(filters.status)}` },
        { value: "type",       label: `Type${listHint(filters.type)}` },
        { value: "estimated",  label: `Estimated${strHint(filters.estimated)}` },
        { value: "from",       label: `Updated from${strHint(filters.from)}` },
        { value: "to",         label: `Updated to${strHint(filters.to)}` },
        { value: "name",       label: `Summary search${strHint(filters.name)}` },
        { value: "__back__",   label: "← Back" },
      ],
    }) as string | symbol;

    if (p.isCancel(field) || field === "__back__") return null;

    if (field === "__search__") {
      const { issues } = await fetchWithFilters(config, projectKey, filters);
      if (issues.length === 0) {
        p.log.warn("No issues found matching your filters.");
        continue; // stay in filter loop so user can adjust
      }
      return issues;
    }

    if (field === "scope") {
      const picked = await pickScope(config, projectKey);
      if (picked !== null) filters.scope = picked;
    } else if (field === "status") {
      const sp = p.spinner();
      sp.start("Loading statuses…");
      let statuses: string[] = [];
      try { statuses = await getProjectStatuses(config, projectKey); } catch { /* ignore */ }
      sp.stop("");
      if (statuses.length > 0) {
        const values = await pickMultiWithMode("Filter by status:", statuses);
        if (values !== null) filters.status = values;
      } else {
        p.log.warn("Could not load statuses — enter manually:");
        const val = await p.text({ message: "Status (comma-separated, prefix not: to exclude):" });
        if (!p.isCancel(val) && val.trim()) filters.status = val.split(",").map((s) => s.trim());
      }
    } else if (field === "type") {
      const sp = p.spinner();
      sp.start("Loading issue types…");
      let types: string[] = [];
      try { types = [...new Set((await getIssueTypes(config)).map((t) => t.name))].sort(); } catch { /* ignore */ }
      sp.stop("");
      if (types.length > 0) {
        const values = await pickMultiWithMode("Filter by type:", types);
        if (values !== null) filters.type = values;
      } else {
        p.log.warn("Could not load issue types — enter manually:");
        const val = await p.text({ message: "Type (comma-separated, prefix not: to exclude):" });
        if (!p.isCancel(val) && val.trim()) filters.type = val.split(",").map((s) => s.trim());
      }
    } else if (field === "estimated") {
      const est = await p.select({
        message: "Estimated:",
        options: [
          { value: "all",    label: "all    — no filter" },
          { value: "yes",    label: "yes    — has original estimate" },
          { value: "no",     label: "no     — missing estimate" },
          { value: "parent", label: "parent — subtask whose parent has an estimate" },
        ],
      }) as string | symbol;
      if (!p.isCancel(est)) filters.estimated = est as JqlFilters["estimated"];
    } else if (field === "from") {
      const val = await p.text({
        message: "Updated from:",
        placeholder: 'e.g. today  -7-day  -1-month  2026-03-01  (negative sign: use "--from=-7-day")',
      });
      if (!p.isCancel(val) && val.trim()) filters.from = val.trim();
    } else if (field === "to") {
      const val = await p.text({
        message: "Updated to:",
        placeholder: 'e.g. today  -7-day  -1-month  2026-03-01',
      });
      if (!p.isCancel(val) && val.trim()) filters.to = val.trim();
    } else if (field === "name") {
      const val = await p.text({
        message: "Summary search:",
        placeholder: 'words and "quoted phrases" — all terms must match, e.g.  login "access denied"',
      });
      if (!p.isCancel(val) && val.trim()) filters.name = val.trim();
    }
    // loop back to filter menu
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function projectPullIssues(
  projectKeyArg: string | undefined,
  scopeArg: string | undefined,
  opts: ProjectPullOpts
): Promise<void> {
  const config = loadConfig();
  const projects = loadProjects();

  // 1. Project selection
  let projectKey = projectKeyArg?.toUpperCase();
  if (!projectKey) {
    const keys = Object.keys(projects);
    if (keys.length === 0) {
      p.log.error("No projects configured. Run `jira project workdir` first.");
      process.exit(1);
    }
    const picked = await runListPicker(
      "Select a project:",
      keys.map((k) => ({ value: k, label: k }))
    );
    if (!picked) return;
    projectKey = picked;
  }

  // 2. Validate workdir
  const projectConfig = projects[projectKey];
  if (!projectConfig?.workingDir) {
    p.log.error(`No working directory configured for ${projectKey}. Run \`jira project workdir ${projectKey}\` first.`);
    process.exit(1);
  }

  // 3. Build base filters from CLI opts
  const baseFilters: JqlFilters = {
    scope: scopeArg,
    from: opts.from,
    to: opts.to,
    fromKey: opts.fromKey,
    toKey: opts.toKey,
    status: opts.status ? opts.status.split(",").map((s) => s.trim()) : undefined,
    type:   opts.type   ? opts.type.split(",").map((s) => s.trim())   : undefined,
    estimated: opts.estimated as JqlFilters["estimated"],
    name: opts.name,
    description: opts.description,
  };

  // 4. If scope is pre-specified via CLI: fetch directly (skip filter loop)
  if (scopeArg) {
    const { issues } = await fetchWithFilters(config, projectKey, baseFilters);
    if (issues.length === 0) {
      p.log.warn("No issues found matching your filters.");
      return;
    }
    if (!opts.pick) {
      await pullIssues(config, issues.map((i) => i.key));
      return;
    }
    const selected = await p.multiselect({
      message: "Select issues to pull:",
      options: issues.map((issue) => ({
        value: issue.key,
        label: issueLabel(issue.key, issue.fields.status.name, issue.fields.summary),
      })),
      required: true,
    });
    if (p.isCancel(selected)) { p.cancel("Cancelled."); return; }
    await pullIssues(config, selected as string[]);
    return;
  }

  // 5. No scope specified: show interactive filter loop
  const issues = await runFilterLoop(config, projectKey, baseFilters, opts.pick ?? false);
  if (!issues) {
    // "← Back" → go back to project picker by re-running
    return projectPullIssues(undefined, undefined, opts);
  }

  // 6. --pick or pull all
  if (!opts.pick) {
    await pullIssues(config, issues.map((i) => i.key));
    return;
  }

  const selected = await p.multiselect({
    message: "Select issues to pull:",
    options: issues.map((issue) => ({
      value: issue.key,
      label: issueLabel(issue.key, issue.fields.status.name, issue.fields.summary),
    })),
    required: true,
  });
  if (p.isCancel(selected)) { p.cancel("Cancelled."); return; }
  await pullIssues(config, selected as string[]);
}
