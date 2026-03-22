export interface TableWidths {
  key?: number;
  type?: number;
  status?: number;
  sprint?: number;
  estimate?: number;
  summary?: number;
}

export interface Config {
  baseUrl: string;
  accountId: string;
  email?: string;          // required for Cloud auth
  authType: "cloud" | "datacenter";
  jiraPat: string;
  tempoPat: string;
  tableWidths?: TableWidths;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  to?: { statusCategory?: { key: string } };
}

export interface JiraComment {
  id: string;
  author: JiraUser;
  body: AdfDoc;
  created: string;
}

export interface AdfDoc {
  version: number;
  type: "doc";
  content: AdfNode[];
}

export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export interface JiraSprint {
  id: number;
  name: string;
  state?: "active" | "future" | "closed";
  startDate?: string;
  endDate?: string;
}

export interface JiraBoard {
  id: number;
  name: string;
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    issuetype: { name: string; iconUrl?: string; subtask: boolean };
    status: { name: string; statusCategory?: { key: string } };
    assignee: JiraUser | null;
    reporter: JiraUser | null;
    priority: { name: string } | null;
    created: string;
    updated: string;
    description: AdfDoc | null;
    timetracking?: {
      originalEstimate?: string;
      remainingEstimate?: string;
    };
    parent?: { key: string; fields?: { timetracking?: { originalEstimate?: string } } };
    comment?: {
      comments: JiraComment[];
      total: number;
    };
    // Sprint is a custom field — may be customfield_10020
    [key: string]: unknown;
  };
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface TempoWorklog {
  tempoWorklogId: number;
  issue: { id: number };
  timeSpentSeconds: number;
  startDate: string;
  startTime: string;
  description: string;
  author: { accountId: string };
}

export interface WorklogEntry {
  issueKey: string;
  durationSeconds: number;
  description: string;
}

export interface ParsedIssueFile {
  key: string;
  summary: string;
  fields: {
    status?: string;
    assignee?: string;
    priority?: string;
    estimate?: string;
  };
  description: string;
}
