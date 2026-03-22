import type { Config } from "./types.ts";
import type { JiraIssue } from "./types.ts";
import { searchIssues as defaultSearchIssues } from "./jira.ts";

type SearchFn = (config: Config, jql: string, maxResults?: number) => Promise<JiraIssue[]>;

/**
 * Post-process --estimated=parent:
 * Filter OUT subtasks that have no estimate but whose parent DOES have an estimate.
 */
export async function applyEstimatedParentFilter(
  config: Config,
  issues: JiraIssue[],
  searchIssues: SearchFn = defaultSearchIssues
): Promise<JiraIssue[]> {
  // Find unestimated subtasks
  const unestimatedSubtasks = issues.filter(
    (i) =>
      i.fields.issuetype.subtask &&
      !i.fields.timetracking?.originalEstimate
  );

  if (unestimatedSubtasks.length === 0) return issues;

  // Collect unique parent keys
  const parentKeys = [
    ...new Set(
      unestimatedSubtasks
        .map((i) => i.fields.parent?.key)
        .filter((k): k is string => Boolean(k))
    ),
  ];

  if (parentKeys.length === 0) return issues;

  // Fetch parents to check their estimates
  const parentIssues = await searchIssues(
    config,
    `key in (${parentKeys.map((k) => `"${k}"`).join(",")})`,
    parentKeys.length
  );

  const estimatedParents = new Set(
    parentIssues
      .filter((p) => p.fields.timetracking?.originalEstimate)
      .map((p) => p.key)
  );

  // Remove subtasks whose parent is estimated
  return issues.filter((i) => {
    if (!i.fields.issuetype.subtask || i.fields.timetracking?.originalEstimate) return true;
    const parentKey = i.fields.parent?.key;
    return !parentKey || !estimatedParents.has(parentKey);
  });
}
