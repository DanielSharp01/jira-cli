import type { Config } from "./types.ts";
import type {
  JiraIssue,
  JiraProject,
  JiraTransition,
  JiraUser,
  JiraSprint,
  JiraBoard,
  JiraIssueType,
  AdfDoc,
} from "./types.ts";
import { getJiraPat } from "./config.ts";

function makeAuthHeader(pat: string, authType: "cloud" | "datacenter", email?: string): string {
  if (authType === "cloud") {
    if (!email) throw new Error("Cloud auth requires an email address in config.");
    return `Basic ${Buffer.from(`${email}:${pat}`).toString("base64")}`;
  }
  return `Bearer ${pat}`;
}

function makeHeaders(pat: string, authType: "cloud" | "datacenter", email?: string): Record<string, string> {
  return {
    Authorization: makeAuthHeader(pat, authType, email),
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function req<T>(
  config: Config,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const pat = getJiraPat(config);
  const url = `${config.baseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: makeHeaders(pat, config.authType, config.email),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> };
      if (parsed.errorMessages?.length) detail = parsed.errorMessages.join(", ");
      else if (parsed.errors) detail = Object.values(parsed.errors).join(", ");
    } catch {
      // keep raw text
    }
    throw new Error(`JIRA ${method} ${path} → ${res.status}: ${detail}`);
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

const ISSUE_FIELDS = [
  "summary", "issuetype", "status", "assignee", "reporter", "priority",
  "created", "updated", "description", "timetracking", "parent",
  "customfield_10020", // sprint
];

export async function getIssue(config: Config, key: string, includeComments = false): Promise<JiraIssue> {
  const fields = includeComments ? [...ISSUE_FIELDS, "comment"] : ISSUE_FIELDS;
  const qs = `fields=${fields.join(",")}`;
  return req<JiraIssue>(config, "GET", `/rest/api/3/issue/${key}?${qs}`);
}

export async function getTransitions(config: Config, key: string): Promise<JiraTransition[]> {
  const res = await req<{ transitions: JiraTransition[] }>(
    config, "GET", `/rest/api/3/issue/${key}/transitions`
  );
  return res.transitions;
}

export async function applyTransition(config: Config, key: string, transitionId: string): Promise<void> {
  await req<void>(config, "POST", `/rest/api/3/issue/${key}/transitions`, {
    transition: { id: transitionId },
  });
}

export async function updateIssue(
  config: Config,
  key: string,
  fields: Record<string, unknown>
): Promise<void> {
  await req<void>(config, "PUT", `/rest/api/3/issue/${key}`, { fields });
}

export async function addComment(config: Config, key: string, body: AdfDoc): Promise<void> {
  await req<void>(config, "POST", `/rest/api/3/issue/${key}/comment`, { body });
}

export async function searchUsers(config: Config, email: string): Promise<JiraUser[]> {
  return req<JiraUser[]>(
    config, "GET",
    `/rest/api/3/user/search?query=${encodeURIComponent(email)}&maxResults=5`
  );
}

export async function getMyself(
  baseUrl: string,
  pat: string,
  authType: "cloud" | "datacenter",
  email?: string
): Promise<JiraUser> {
  const res = await fetch(`${baseUrl}/rest/api/3/myself`, {
    headers: makeHeaders(pat, authType, email),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`JIRA /myself → ${res.status}: ${text}`);
  return JSON.parse(text) as JiraUser;
}

export async function getSprint(config: Config, sprintId: number): Promise<JiraSprint> {
  return req<JiraSprint>(
    config, "GET",
    `/rest/agile/1.0/sprint/${sprintId}`
  );
}

export async function getProjects(config: Config): Promise<JiraProject[]> {
  const all: JiraProject[] = [];
  let startAt = 0;

  while (true) {
    const res = await req<{ values: JiraProject[]; isLast: boolean }>(
      config, "GET", `/rest/api/3/project/search?maxResults=100&orderBy=key&startAt=${startAt}`
    );
    all.push(...res.values);
    if (res.isLast || res.values.length === 0) break;
    startAt += res.values.length;
  }

  return all;
}

export async function getIssueKeysByIds(config: Config, ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const res = await req<{ issues: Array<{ id: string; key: string }> }>(
    config, "POST", `/rest/api/3/search/jql`,
    { jql: `id in (${ids.join(",")})`, fields: ["summary"], maxResults: ids.length }
  );
  const map = new Map<number, string>();
  for (const issue of res.issues) {
    map.set(Number(issue.id), issue.key);
  }
  return map;
}

export async function getIssueIdsByKeys(config: Config, keys: string[]): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();
  const quoted = keys.map(k => `"${k}"`).join(",");
  const res = await req<{ issues: Array<{ id: string; key: string }> }>(
    config, "POST", `/rest/api/3/search/jql`,
    { jql: `key in (${quoted})`, fields: ["summary"], maxResults: keys.length }
  );
  const map = new Map<string, number>();
  for (const issue of res.issues) {
    map.set(issue.key, Number(issue.id));
  }
  return map;
}

export async function searchIssues(
  config: Config,
  jql: string,
  maxResults = 500
): Promise<JiraIssue[]> {
  const pageSize = 100;
  const all: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  while (all.length < maxResults) {
    const limit = Math.min(pageSize, maxResults - all.length);
    const body: Record<string, unknown> = { jql, fields: ISSUE_FIELDS, maxResults: limit };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const res = await req<{ issues: JiraIssue[]; nextPageToken?: string }>(
      config, "POST", `/rest/api/3/search/jql`, body
    );
    all.push(...res.issues);
    if (!res.nextPageToken || res.issues.length === 0) break;
    nextPageToken = res.nextPageToken;
  }

  return all;
}

/** Extract sprint from issue fields (customfield_10020 is the standard sprint field) */
export function extractSprint(issue: JiraIssue): { id: number } | null {
  const raw = issue.fields.customfield_10020;
  if (!raw) return null;
  // Can be an array of sprints or a single sprint object
  if (Array.isArray(raw) && raw.length > 0) {
    return raw[raw.length - 1] as { id: number };
  }
  if (typeof raw === "object" && raw !== null && "id" in raw) {
    return raw as { id: number };
  }
  return null;
}

export async function getIssueTypes(config: Config): Promise<JiraIssueType[]> {
  return req<JiraIssueType[]>(config, "GET", "/rest/api/3/issuetype");
}

export async function getProjectStatuses(config: Config, projectKey: string): Promise<string[]> {
  // Returns unique status names available in the project
  const data = await req<Array<{ statuses: Array<{ name: string }> }>>(
    config, "GET", `/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses`
  );
  const seen = new Set<string>();
  for (const issueType of data) {
    for (const s of issueType.statuses) {
      seen.add(s.name);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export async function getBoards(config: Config, projectKey: string): Promise<JiraBoard[]> {
  const all: JiraBoard[] = [];
  let startAt = 0;
  while (true) {
    const res = await req<{ values: JiraBoard[]; isLast: boolean }>(
      config, "GET",
      `/rest/agile/1.0/board?projectKeyOrId=${encodeURIComponent(projectKey)}&type=scrum,kanban&maxResults=50&startAt=${startAt}`
    );
    all.push(...res.values);
    if (res.isLast || res.values.length === 0) break;
    startAt += res.values.length;
  }
  return all;
}

export interface ChangelogItem {
  field: string;
  fromString: string | null;
  toString: string | null;
}

export interface ChangelogEntry {
  created: string;
  items: ChangelogItem[];
}

export async function getIssueChangelog(
  config: Config,
  key: string
): Promise<ChangelogEntry[]> {
  const all: ChangelogEntry[] = [];
  let startAt = 0;

  while (true) {
    const res = await req<{ values: ChangelogEntry[]; isLast?: boolean; maxResults: number }>(
      config, "GET",
      `/rest/api/3/issue/${key}/changelog?maxResults=100&startAt=${startAt}`
    );
    all.push(...res.values);
    if (res.isLast !== false || res.values.length === 0) break;
    startAt += res.values.length;
  }

  return all;
}

export async function getBoardSprints(
  config: Config,
  boardId: number,
  state: "active" | "future" | "closed"
): Promise<JiraSprint[]> {
  const all: JiraSprint[] = [];
  let startAt = 0;
  while (true) {
    const res = await req<{ values: JiraSprint[]; isLast: boolean }>(
      config, "GET",
      `/rest/agile/1.0/board/${boardId}/sprint?state=${state}&maxResults=50&startAt=${startAt}`
    );
    all.push(...res.values);
    if (res.isLast || res.values.length === 0) break;
    startAt += res.values.length;
  }
  return all;
}
