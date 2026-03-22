import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { JiraIssue } from "../lib/types.ts";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports
// ---------------------------------------------------------------------------

const CONFIG = {
  baseUrl: "https://test.atlassian.net",
  accountId: "acc1",
  authType: "cloud" as const,
  jiraPat: "jp",
  tempoPat: "tp",
  email: "a@b.com",
};

mock.module("../lib/config.ts", () => ({ loadConfig: () => CONFIG }));

const mockSearchIssues = mock(async (): Promise<JiraIssue[]> => []);
const mockGetIssue = mock(async (): Promise<JiraIssue> => makeIssue("PROJ-1", "Story", false));
const mockGetProjects = mock(async () => [{ id: "1", key: "PROJ", name: "Project" }]);
const mockGetBoards = mock(async () => [{ id: 1, name: "Board" }]);
const mockGetBoardSprints = mock(async () => []);

mock.module("../lib/jira.ts", () => ({
  searchIssues: mockSearchIssues,
  getIssue: mockGetIssue,
  getProjects: mockGetProjects,
  getBoards: mockGetBoards,
  getBoardSprints: mockGetBoardSprints,
  extractSprint: () => null,
}));

mock.module("../lib/projects.ts", () => ({
  loadProjects: () => ({ PROJ: { workingDir: "/tmp/proj" } }),
  resolveIssuePath: (key: string) => `/tmp/proj/${key}.md`,
}));

mock.module("../lib/format.ts", () => ({
  issueToMarkdown: () => "# markdown",
}));

mock.module("../lib/snapshot.ts", () => ({
  writeSnapshot: () => {},
  setActiveFile: () => {},
}));


mock.module("picocolors", () => ({
  default: { green: (s: string) => s, dim: (s: string) => s },
}));

const mockSpinner = { start: mock(() => {}), stop: mock(() => {}), message: mock(() => {}) };
const mockLogError = mock((_: string) => {});
const mockLogWarn = mock((_: string) => {});
const mockCancel = mock(() => {});
const mockMultiselect = mock(async () => ["PROJ-1"]);

mock.module("@clack/prompts", () => ({
  spinner: () => mockSpinner,
  log: { error: mockLogError, warn: mockLogWarn },
  cancel: mockCancel,
  isCancel: () => false,
  multiselect: mockMultiselect,
}));


import { projectPullIssues } from "../cli/project/pull.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(key: string, type: string, subtask: boolean): JiraIssue {
  return {
    id: key,
    key,
    fields: {
      summary: `Summary of ${key}`,
      issuetype: { name: type, subtask },
      status: { name: "To Do", statusCategory: { key: "new" } },
      assignee: null,
      reporter: null,
      priority: null,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      description: null,
    },
  };
}

// ---------------------------------------------------------------------------
// projectPullIssues — auto-pull vs --pick
// ---------------------------------------------------------------------------

describe("projectPullIssues — auto-pull (no --pick)", () => {
  beforeEach(() => {
    mockSearchIssues.mockReset();
    mockGetIssue.mockReset();
    mockSpinner.start.mockReset();
    mockSpinner.stop.mockReset();
    mockMultiselect.mockReset();
  });

  test("pulls all issues without showing multiselect when project and scope are provided", async () => {
    const issue = makeIssue("PROJ-1", "Story", false);
    mockSearchIssues.mockResolvedValue([issue]);
    mockGetIssue.mockResolvedValue(issue);

    await projectPullIssues("PROJ", "all", {});

    expect(mockMultiselect).not.toHaveBeenCalled();
    expect(mockGetIssue).toHaveBeenCalledWith(CONFIG, "PROJ-1", false);
  });

  test("shows warning and returns when no issues found", async () => {
    mockSearchIssues.mockResolvedValue([]);

    await projectPullIssues("PROJ", "all", {});

    expect(mockLogWarn).toHaveBeenCalled();
    expect(mockGetIssue).not.toHaveBeenCalled();
  });
});

describe("projectPullIssues — result cap", () => {
  const SEARCH_CAP = 500;

  beforeEach(() => {
    mockSearchIssues.mockReset();
    mockGetIssue.mockReset();
    mockSpinner.stop.mockReset();
  });

  test("requests cap+1 from Jira so it can detect overflow", async () => {
    mockSearchIssues.mockResolvedValue([]);

    await projectPullIssues("PROJ", "all", {});

    expect(mockSearchIssues).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      SEARCH_CAP + 1
    );
  });

  test("when Jira returns cap+1 issues, only cap are pulled and spinner shows capped message", async () => {
    const issues = Array.from({ length: SEARCH_CAP + 1 }, (_, i) =>
      makeIssue(`PROJ-${i + 1}`, "Story", false)
    );
    mockSearchIssues.mockResolvedValue(issues);
    mockGetIssue.mockResolvedValue(makeIssue("PROJ-1", "Story", false));

    await projectPullIssues("PROJ", "all", {});

    expect(mockGetIssue).toHaveBeenCalledTimes(SEARCH_CAP);
    expect(mockSpinner.stop).toHaveBeenCalledWith(expect.stringContaining("500+"));
  });

  test("when Jira returns fewer than cap issues, all are pulled and no capped message shown", async () => {
    const issues = Array.from({ length: 5 }, (_, i) =>
      makeIssue(`PROJ-${i + 1}`, "Story", false)
    );
    mockSearchIssues.mockResolvedValue(issues);
    mockGetIssue.mockResolvedValue(makeIssue("PROJ-1", "Story", false));

    await projectPullIssues("PROJ", "all", {});

    expect(mockGetIssue).toHaveBeenCalledTimes(5);
    const stopCalls = mockSpinner.stop.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(stopCalls.some((msg: string) => msg.includes("capped"))).toBe(false);
  });
});

describe("projectPullIssues — --pick", () => {
  beforeEach(() => {
    mockSearchIssues.mockReset();
    mockGetIssue.mockReset();
    mockMultiselect.mockReset();
  });

  test("shows multiselect and only pulls selected issues", async () => {
    const issue1 = makeIssue("PROJ-1", "Story", false);
    const issue2 = makeIssue("PROJ-2", "Bug", false);
    mockSearchIssues.mockResolvedValue([issue1, issue2]);
    mockGetIssue.mockResolvedValue(issue1);
    mockMultiselect.mockResolvedValue(["PROJ-1"]);

    await projectPullIssues("PROJ", "all", { pick: true });

    expect(mockMultiselect).toHaveBeenCalled();
    expect(mockGetIssue).toHaveBeenCalledWith(CONFIG, "PROJ-1", false);
    expect(mockGetIssue).not.toHaveBeenCalledWith(CONFIG, "PROJ-2", false);
  });
});
