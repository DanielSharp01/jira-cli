import * as p from "@clack/prompts";
import { loadConfig } from "../lib/config.ts";
import { getProjects, searchIssues, getIssueTypes, getProjectStatuses } from "../lib/jira.ts";
import { buildJql, type JqlFilters } from "../lib/jql.ts";
import { applyEstimatedParentFilter } from "../lib/estimated.ts";
import { runListPicker, runTablePicker, sprintDateRange, type ColDef, type SortState } from "../lib/tui.ts";
import { describeIssue } from "./issue/describe.ts";
import { commentOnIssue } from "./issue/comment.ts";
import { setStatus } from "./issue/status.ts";
import type { JiraIssue } from "../lib/types.ts";
import { extractSprint } from "../lib/jira.ts";
import { pickScope, pickMultiWithMode } from "./filters.ts";

// ---------------------------------------------------------------------------
// Opts type (mirrors cli/index.ts)
// ---------------------------------------------------------------------------

export interface ExploreOpts {
  from?: string;
  to?: string;
  fromKey?: number;
  toKey?: number;
  status?: string;
  type?: string;
  estimated?: string;
  name?: string;
  description?: string;
  interactive?: boolean;
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

function sprintName(issue: JiraIssue): string {
  const raw = issue.fields.customfield_10020;
  if (!raw) return "";
  const sprints = Array.isArray(raw) ? raw : [raw];
  const last = sprints[sprints.length - 1] as { name?: string } | undefined;
  return last?.name ?? "";
}

function buildColDefs(tw: ReturnType<typeof loadConfig>["tableWidths"]): ColDef<JiraIssue>[] {
  return [
    { key: "key",      header: "KEY",      render: (i) => i.key,                                                    minWidth: tw?.key      ?? 13, defaultVisible: true,  sortable: true  },
    { key: "type",     header: "TYPE",     render: (i) => i.fields.issuetype.name,                                  minWidth: tw?.type     ?? 10, defaultVisible: true,  sortable: true  },
    { key: "status",   header: "STATUS",   render: (i) => i.fields.status.name,                                     minWidth: tw?.status   ?? 22, defaultVisible: true,  sortable: true  },
    { key: "sprint",   header: "SPRINT",   render: (i) => sprintName(i),                                            minWidth: tw?.sprint   ?? 16, defaultVisible: true,  sortable: true  },
    { key: "estimate", header: "ESTIMATE", render: (i) => i.fields.timetracking?.originalEstimate ?? "—",           minWidth: tw?.estimate ??  8, defaultVisible: true,  sortable: true  },
    { key: "summary",  header: "SUMMARY",  render: (i) => i.fields.summary,                                         minWidth: tw?.summary  ?? 58, defaultVisible: true,  sortable: false },
  ];
}

// ---------------------------------------------------------------------------
// Filter field prompts
// ---------------------------------------------------------------------------

const FILTER_FIELD_OPTIONS = [
  { value: "scope",       label: "Scope / sprint" },
  { value: "status",      label: "Status" },
  { value: "type",        label: "Type" },
  { value: "estimated",   label: "Estimated" },
  { value: "from",        label: "Updated from" },
  { value: "to",          label: "Updated to" },
  { value: "name",        label: "Summary search" },
  { value: "description", label: "Description search" },
  { value: "__back__",    label: "← Back" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function optsToFilters(scope: string | undefined, opts: ExploreOpts): JqlFilters {
  return {
    scope,
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
}

const SEARCH_CAP = 500;

async function fetchIssues(config: ReturnType<typeof loadConfig>, projectKey: string, filters: JqlFilters): Promise<{ issues: JiraIssue[]; hasMore: boolean }> {
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
  spinner.stop(`Found ${issues.length} issue(s)`);
  return { issues, hasMore };
}

// ---------------------------------------------------------------------------
// Inner table loop (one project)
// ---------------------------------------------------------------------------

async function runProjectTable(
  config: ReturnType<typeof loadConfig>,
  projectKey: string,
  scopeArg: string | undefined,
  opts: ExploreOpts
): Promise<void> {
  const COL_DEFS = buildColDefs(config.tableWidths);
  const DEFAULT_VISIBLE = COL_DEFS.filter((c) => c.defaultVisible).map((c) => c.key);

  const activeFilters: JqlFilters = optsToFilters(scopeArg, opts);
  let { issues, hasMore } = await fetchIssues(config, projectKey, activeFilters);

  let cursorIndex = 0;
  let sortState: SortState[] = [];
  const visibleCols = [...DEFAULT_VISIBLE];

  while (true) {
    process.stdout.write("\x1B[2J\x1B[H");
    const title = `${projectKey}${activeFilters.scope ? ` (${activeFilters.scope})` : ""}`;
    const result = await runTablePicker(title, COL_DEFS, issues, {
      initialCursor: cursorIndex,
      initialSort: sortState,
      initialVisibleCols: visibleCols,
      hasMore,
      groupBy: {
        getId: (i) => i.key,
        getParentId: (i) => i.fields.parent?.key,
      },
    });

    if (result.action === "exit") break;

    cursorIndex = result.cursorIndex;
    sortState   = result.sortState;

    // -----------------------------------------------------------------------
    // Issue selected — describe + action submenu
    // -----------------------------------------------------------------------
    if (result.action === "open") {
      const { item } = result;
      while (true) {
        process.stdout.write("\x1B[2J\x1B[H");
        await describeIssue(item.key);
        const action = await p.select({
          message: "What would you like to do?",
          options: [
            { value: "back",    label: "← Back to issues" },
            { value: "status",  label: "Change status" },
            { value: "comment", label: "Add comment" },
          ],
        }) as string | symbol;
        if (p.isCancel(action) || action === "back") break;
        if (action === "status")  await setStatus(item.key);
        if (action === "comment") await commentOnIssue(item.key);
        // loop — re-describe after action
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // Filter menu
    // -----------------------------------------------------------------------
    if (result.action === "filter") {
      while (true) {
        const field = await p.select({
          message: "Filter by:",
          options: FILTER_FIELD_OPTIONS,
        }) as string | symbol;
        if (p.isCancel(field) || field === "__back__") break;

        let applied = false;

        if (field === "scope") {
          const picked = await pickScope(config, projectKey);
          if (picked !== null) {
            activeFilters.scope = picked;
            applied = true;
          }
        } else if (field === "status") {
          const sp = p.spinner();
          sp.start("Loading statuses…");
          let statuses: string[] = [];
          try { statuses = await getProjectStatuses(config, projectKey); } catch { /* ignore */ }
          sp.stop("");
          if (statuses.length > 0) {
            const values = await pickMultiWithMode("Filter by status:", statuses);
            if (values !== null) {
              activeFilters.status = values;
              applied = true;
            }
          } else {
            p.log.warn("Could not load statuses — enter manually:");
            const val = await p.text({ message: "Status (comma-separated, prefix not: to exclude):" });
            if (!p.isCancel(val) && val.trim()) { activeFilters.status = val.split(",").map((s) => s.trim()); applied = true; }
          }
        } else if (field === "type") {
          const sp = p.spinner();
          sp.start("Loading issue types…");
          let types: string[] = [];
          try { types = [...new Set((await getIssueTypes(config)).map((t) => t.name))].sort(); } catch { /* ignore */ }
          sp.stop("");
          if (types.length > 0) {
            const values = await pickMultiWithMode("Filter by type:", types);
            if (values !== null) {
              activeFilters.type = values;
              applied = true;
            }
          } else {
            p.log.warn("Could not load issue types — enter manually:");
            const val = await p.text({ message: "Type (comma-separated, prefix not: to exclude):" });
            if (!p.isCancel(val) && val.trim()) { activeFilters.type = val.split(",").map((s) => s.trim()); applied = true; }
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
          if (!p.isCancel(est)) { activeFilters.estimated = est as JqlFilters["estimated"]; applied = true; }
        } else if (field === "from" || field === "to") {
          const val = await p.text({
            message: field === "from" ? "Updated from:" : "Updated to:",
            placeholder: 'e.g. today  -7-day  -1-month  2026-03-01  (negative sign: use "--from=-7-day")',
          });
          if (!p.isCancel(val) && val.trim()) {
            if (field === "from") activeFilters.from = val.trim();
            else activeFilters.to = val.trim();
            applied = true;
          }
        } else if (field === "name") {
          const val = await p.text({
            message: "Summary search:",
            placeholder: 'words and "quoted phrases" — all terms must match, e.g.  login "access denied"',
          });
          if (!p.isCancel(val) && val.trim()) { activeFilters.name = val.trim(); applied = true; }
        } else if (field === "description") {
          const val = await p.text({
            message: "Description search:",
            placeholder: 'words and "quoted phrases" — all terms must match, e.g.  login "access denied"',
          });
          if (!p.isCancel(val) && val.trim()) { activeFilters.description = val.trim(); applied = true; }
        }

        if (applied) {
          ({ issues, hasMore } = await fetchIssues(config, projectKey, activeFilters));
          cursorIndex = 0;
        }
        // loop — stay in filter picker
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // Sort menu
    // -----------------------------------------------------------------------
    if (result.action === "sort") {
      while (true) {
        const sortableKeys = COL_DEFS.filter((c) => c.sortable).map((c) => ({ value: c.key, label: c.header }));
        const currentHint = sortState.length > 0
          ? `  (current: ${sortState.map((s) => `${s.colKey} ${s.dir}`).join(", ")})`
          : "";
        const col = await p.select({
          message: `Add sort column${currentHint}:`,
          options: [
            { value: "__reset__", label: "↺  Reset to default order" },
            ...sortableKeys,
            { value: "__back__",  label: "←  Back" },
          ],
        }) as string | symbol;
        if (p.isCancel(col) || col === "__back__") break;
        if (col === "__reset__") { sortState = []; break; }
        const dir = await p.select({
          message: "Direction:",
          options: [
            { value: "asc",  label: "Ascending ▲" },
            { value: "desc", label: "Descending ▼" },
          ],
        }) as string | symbol;
        if (!p.isCancel(dir)) {
          sortState = [...sortState, { colKey: col as string, dir: dir as "asc" | "desc" }];
        }
        // loop — allow adding more sort columns
      }
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// Non-interactive output
// ---------------------------------------------------------------------------

function printIssuesTable(issues: JiraIssue[], colDefs: ColDef<JiraIssue>[]): void {
  const cols = colDefs.map((c) => ({
    header: c.header,
    width:  c.minWidth ?? 10,
    render: c.render,
  }));

  const padPlain = (s: string, w: number) => s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
  const header = cols.map((c) => padPlain(c.header, c.width)).join("  ");
  const sep    = cols.map((c) => "-".repeat(c.width)).join("  ");

  process.stdout.write(`${header}\n${sep}\n`);
  for (const issue of issues) {
    const row = cols.map((c) => padPlain(c.render(issue), c.width)).join("  ");
    process.stdout.write(`${row}\n`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function exploreIssues(
  projectKeyArg: string | undefined,
  scopeArg: string | undefined,
  opts: ExploreOpts
): Promise<void> {
  const config = loadConfig();

  if (opts.interactive === false) {
    if (!projectKeyArg) {
      p.log.error("--no-interactive requires a project key: jira explore <PROJECT> [scope] --no-interactive");
      process.exit(1);
    }
    const filters = optsToFilters(scopeArg, opts);
    const { issues } = await fetchIssues(config, projectKeyArg.toUpperCase(), filters);
    printIssuesTable(issues, buildColDefs(config.tableWidths));
    return;
  }

  // When a project key is provided via CLI, go straight to the table.
  // "← Back" in the table just exits (nothing to go back to).
  if (projectKeyArg) {
    await runProjectTable(config, projectKeyArg.toUpperCase(), scopeArg, opts);
    return;
  }

  // When no project was specified, show the project picker in a loop so that
  // "← Back" in the table returns here instead of exiting the process.
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
  spinner.stop(`Found ${projects.length} project(s)`);

  if (projects.length === 0) { p.log.error("No accessible JIRA projects found."); process.exit(1); }

  while (true) {
    const picked = await runListPicker(
      "Select a project:",
      projects.map((pr) => ({ value: pr.key, label: `${pr.key} — ${pr.name}` }))
    );
    if (!picked) return; // CTRL-C → exit

    await runProjectTable(config, picked, scopeArg, opts);
    // After "← Back" in the table, loop back to project picker
  }
}


// Re-export extractSprint so it's used (avoids lint unused import warning)
export { extractSprint };

// Re-export for test convenience
export { optsToFilters };

// Re-export sprintDateRange so it's used (avoids lint unused import warning)
export { sprintDateRange };
