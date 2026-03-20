export type IssueScope = "sprint" | "backlog" | "all";

export interface JqlFilters {
  scope?: IssueScope;
  from?: string;       // ISO date — adds: AND updated >= "DATE"
  status?: string[];   // adds: AND status in ("S1","S2")
}

export function buildJql(projectKey: string, filters: JqlFilters): string {
  const parts: string[] = [];

  const scope = filters.scope ?? "all";
  if (scope === "sprint") {
    parts.push(`project = "${projectKey}" AND sprint in openSprints()`);
  } else if (scope === "backlog") {
    parts.push(`project = "${projectKey}" AND sprint is EMPTY AND statusCategory != Done`);
  } else {
    parts.push(`project = "${projectKey}"`);
  }

  if (filters.status && filters.status.length > 0) {
    const quoted = filters.status.map((s) => `"${s}"`).join(",");
    parts.push(`status in (${quoted})`);
  }

  if (filters.from) {
    parts.push(`updated >= "${filters.from}"`);
  }

  return parts.join(" AND ") + " ORDER BY updated DESC";
}
