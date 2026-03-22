export type IssueScope = string; // "sprint"|"current-sprint"|"backlog"|"all"|"<named sprint>"

export interface JqlFilters {
  scope?: IssueScope;
  from?: string;          // updated >= "DATE"
  to?: string;            // updated <= "DATE"
  fromKey?: number;       // key >= "PROJ-N"
  toKey?: number;         // key <= "PROJ-N"
  status?: string[];      // "not:..." prefix → NOT IN; else IN (case-insensitive prefix check)
  type?: string[];        // same not: prefix support
  estimated?: "all" | "yes" | "no" | "parent";
  name?: string;          // Google-style token string → summary ~ clauses
  description?: string;   // Google-style token string → description ~ clauses
}

/** Parse a Google-style search string into tokens.
 *  "quoted phrase" → exact token, bare words → individual tokens. */
export function parseSearchTokens(input: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    tokens.push(m[1] ?? m[2] ?? "");
  }
  return tokens.filter(Boolean);
}

/** Build JQL clauses for a Google-style search string against a field. */
function textSearchClauses(field: string, query: string): string[] {
  return parseSearchTokens(query).map((t) => `${field} ~ "${t.replace(/"/g, '\\"')}"`);
}

/** Split a list of filter values into positive and negated (not: prefix) groups.
 *  Comparison is case-insensitive on the prefix. */
function splitNot(values: string[]): { positive: string[]; negated: string[] } {
  const positive: string[] = [];
  const negated: string[] = [];
  for (const v of values) {
    if (v.toLowerCase().startsWith("not:")) {
      negated.push(v.slice(4));
    } else {
      positive.push(v);
    }
  }
  return { positive, negated };
}

function quoted(values: string[]): string {
  return values.map((v) => `"${v.replace(/"/g, '\\"')}"`).join(", ");
}

export function buildJql(projectKey: string, filters: JqlFilters): string {
  const parts: string[] = [];
  const scope = filters.scope ?? "all";
  const scopeLower = scope.toLowerCase();

  if (scopeLower === "sprint" || scopeLower === "current-sprint") {
    parts.push(`project = "${projectKey}" AND sprint in openSprints()`);
  } else if (scopeLower === "backlog") {
    parts.push(`project = "${projectKey}" AND sprint is EMPTY AND statusCategory != Done`);
  } else if (scopeLower === "all" || !scope) {
    parts.push(`project = "${projectKey}"`);
  } else {
    // Named sprint
    parts.push(`project = "${projectKey}" AND sprint = "${scope.replace(/"/g, '\\"')}"`);
  }

  if (filters.status && filters.status.length > 0) {
    const { positive, negated } = splitNot(filters.status);
    if (positive.length > 0) parts.push(`status IN (${quoted(positive)})`);
    if (negated.length > 0) parts.push(`status NOT IN (${quoted(negated)})`);
  }

  if (filters.type && filters.type.length > 0) {
    const { positive, negated } = splitNot(filters.type);
    if (positive.length > 0) parts.push(`issuetype IN (${quoted(positive)})`);
    if (negated.length > 0) parts.push(`issuetype NOT IN (${quoted(negated)})`);
  }

  if (filters.estimated === "yes") {
    parts.push(`"timeoriginalestimate" is not EMPTY`);
  } else if (filters.estimated === "no") {
    parts.push(`"timeoriginalestimate" is EMPTY`);
  }
  // "parent" and "all" → no JQL clause (parent handled in post-processing)

  if (filters.from) {
    parts.push(`updated >= "${filters.from}"`);
  }

  if (filters.to) {
    parts.push(`updated <= "${filters.to}"`);
  }

  if (filters.fromKey !== undefined) {
    parts.push(`key >= "${projectKey}-${filters.fromKey}"`);
  }

  if (filters.toKey !== undefined) {
    parts.push(`key <= "${projectKey}-${filters.toKey}"`);
  }

  if (filters.name) {
    parts.push(...textSearchClauses("summary", filters.name));
  }

  if (filters.description) {
    parts.push(...textSearchClauses("description", filters.description));
  }

  return `${parts.join(" AND ")} ORDER BY updated DESC`;
}
