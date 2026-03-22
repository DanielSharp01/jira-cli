import { describe, test, expect } from "bun:test";
import type { JiraIssue, Config } from "../lib/types.ts";
import { applyEstimatedParentFilter } from "../lib/estimated.ts";

// ---------------------------------------------------------------------------
// Config + mock searcher
// ---------------------------------------------------------------------------

const CONFIG: Config = {
  baseUrl: "https://test.atlassian.net",
  accountId: "acc1",
  authType: "cloud",
  jiraPat: "jp",
  tempoPat: "tp",
  email: "a@b.com",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeIssue(
  key: string,
  subtask: boolean,
  opts: { estimate?: string; parentKey?: string } = {}
): JiraIssue {
  return {
    id: key,
    key,
    fields: {
      summary: `Summary of ${key}`,
      issuetype: { name: subtask ? "Sub-task" : "Story", subtask },
      status: { name: "To Do", statusCategory: { key: "new" } },
      assignee: null,
      reporter: null,
      priority: null,
      created: "2026-01-01T00:00:00Z",
      updated: "2026-01-01T00:00:00Z",
      description: null,
      timetracking: opts.estimate ? { originalEstimate: opts.estimate } : undefined,
      parent: opts.parentKey ? { key: opts.parentKey } : undefined,
    },
  };
}

function makeParent(key: string, estimate?: string): JiraIssue {
  return makeIssue(key, false, { estimate });
}

// Simple stub that returns a fixed list of issues
function stubSearch(parents: JiraIssue[]) {
  let called = false;
  const fn = async (_config: Config, _jql: string): Promise<JiraIssue[]> => {
    called = true;
    return parents;
  };
  fn.wasCalled = () => called;
  return fn;
}

function filter(issues: JiraIssue[], parents: JiraIssue[] = []) {
  return applyEstimatedParentFilter(CONFIG, issues, stubSearch(parents).bind(null));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("applyEstimatedParentFilter", () => {
  test("keeps issues that are not subtasks", async () => {
    const story = makeIssue("PROJ-1", false);
    const result = await filter([story]);
    expect(result).toContain(story);
  });

  test("keeps subtask that has its own estimate", async () => {
    const sub = makeIssue("PROJ-2", true, { estimate: "2h" });
    const result = await filter([sub]);
    expect(result).toContain(sub);
  });

  test("keeps unestimated subtask whose parent has no estimate", async () => {
    const sub = makeIssue("PROJ-2", true, { parentKey: "PROJ-1" });
    const result = await filter([sub], [makeParent("PROJ-1")]);
    expect(result).toContain(sub);
  });

  test("removes unestimated subtask whose parent HAS an estimate", async () => {
    const sub = makeIssue("PROJ-2", true, { parentKey: "PROJ-1" });
    const result = await filter([sub], [makeParent("PROJ-1", "8h")]);
    expect(result).not.toContain(sub);
  });

  test("keeps unestimated subtask with no parent key", async () => {
    const sub = makeIssue("PROJ-2", true);
    const result = await filter([sub]);
    expect(result).toContain(sub);
  });

  test("handles mixed subtasks, only removes ones with estimated parents", async () => {
    const sub1 = makeIssue("PROJ-2", true, { parentKey: "PROJ-1" });
    const sub2 = makeIssue("PROJ-3", true, { parentKey: "PROJ-4" });
    const result = await filter([sub1, sub2], [
      makeParent("PROJ-1", "8h"), // estimated → remove sub1
      makeParent("PROJ-4"),       // no estimate → keep sub2
    ]);
    expect(result).not.toContain(sub1);
    expect(result).toContain(sub2);
  });

  test("skips parent fetch when no unestimated subtasks exist", async () => {
    const story = makeIssue("PROJ-1", false, { estimate: "4h" });
    let fetchCalled = false;
    const searchFn = async () => { fetchCalled = true; return [] as JiraIssue[]; };
    await applyEstimatedParentFilter(CONFIG, [story], searchFn);
    expect(fetchCalled).toBe(false);
  });
});
