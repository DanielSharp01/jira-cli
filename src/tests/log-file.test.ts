import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TempoWorklog } from "../lib/types.ts";

// ---------------------------------------------------------------------------
// Module mocks
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

const mockGetWorklogsForRange = mock(async (): Promise<TempoWorklog[]> => []);
const mockGetWorkingDays = mock(async (): Promise<string[]> => []);
const mockCreateWorklog = mock(async (): Promise<TempoWorklog> => ({
  tempoWorklogId: 999, issue: { id: 100 }, timeSpentSeconds: 3600,
  startDate: "2026-03-16", startTime: "09:00:00", description: "created",
  author: { accountId: "acc1" },
}));
const mockDeleteWorklog = mock(async (): Promise<void> => {});
mock.module("../lib/tempo.ts", () => ({
  getWorklogsForRange: mockGetWorklogsForRange,
  getWorkingDays: mockGetWorkingDays,
  createWorklog: mockCreateWorklog,
  deleteWorklog: mockDeleteWorklog,
}));

const mockGetIssueIdsByKeys = mock(async (): Promise<Map<string, number>> => new Map([["ABC-1", 100]]));
const mockGetIssueKeysByIds = mock(async (): Promise<Map<number, string>> => new Map([[100, "ABC-1"]]));
mock.module("../lib/jira.ts", () => ({
  getIssueIdsByKeys: mockGetIssueIdsByKeys,
  getIssueKeysByIds: mockGetIssueKeysByIds,
}));

mock.module("picocolors", () => ({
  default: {
    bold: (s: string) => s, green: (s: string) => s, cyan: (s: string) => s,
    dim: (s: string) => s, yellow: (s: string) => s, red: (s: string) => s,
  },
}));

const mockConfirm = mock(async (): Promise<boolean> => true);
const mockSelect = mock(async (): Promise<string> => "yes");
mock.module("@clack/prompts", () => ({
  spinner: () => ({ start: mock(() => {}), stop: mock(() => {}) }),
  log: { error: mock(() => {}), warn: mock(() => {}) },
  confirm: mockConfirm,
  select: mockSelect,
  isCancel: (_v: unknown) => false,
  cancel: mock(() => {}),
}));

import { logTempo } from "../cli/tempo/log.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpFiles: string[] = [];

function writeTmp(content: string): string {
  const path = join(tmpdir(), `jira-test-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(path, content, "utf8");
  tmpFiles.push(path);
  return path;
}

function mkFile(...days: Array<{ date: string; entries: string[] }>): string {
  return days.map(d => [`# ${d.date}`, ...d.entries.map(e => `- ${e}`), ""].join("\n")).join("\n");
}

function wl(id: number, date: string, secs: number): TempoWorklog {
  return {
    tempoWorklogId: id, issue: { id: 100 }, timeSpentSeconds: secs,
    startDate: date, startTime: "09:00:00", description: "existing",
    author: { accountId: "acc1" },
  };
}

const MON = "2026-03-16";
const TUE = "2026-03-17";

let logs: string[];

beforeEach(() => {
  logs = [];
  spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  mockGetWorklogsForRange.mockReset();
  mockGetWorkingDays.mockReset();
  mockCreateWorklog.mockReset();
  mockDeleteWorklog.mockReset();
  mockGetIssueIdsByKeys.mockReset();
  mockGetIssueKeysByIds.mockReset();
  mockConfirm.mockReset();
  mockSelect.mockReset();

  // Defaults
  mockGetWorklogsForRange.mockResolvedValue([]);
  mockGetWorkingDays.mockResolvedValue([MON]);
  mockCreateWorklog.mockResolvedValue({
    tempoWorklogId: 999, issue: { id: 100 }, timeSpentSeconds: 3600,
    startDate: MON, startTime: "09:00:00", description: "done", author: { accountId: "acc1" },
  });
  mockGetIssueIdsByKeys.mockResolvedValue(new Map([["ABC-1", 100]]));
  mockGetIssueKeysByIds.mockResolvedValue(new Map([[100, "ABC-1"]]));
  mockConfirm.mockResolvedValue(true);
  mockSelect.mockResolvedValue("yes");
});

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("logTempo file mode — basic", () => {
  test("creates worklog for each entry in file", async () => {
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 fixed the bug 2h"] }));

    await logTempo(MON, MON, { file });

    expect(mockCreateWorklog).toHaveBeenCalledTimes(1);
    const call = (mockCreateWorklog.mock.calls as unknown[][])[0]![1] as { issueId: number; timeSpentSeconds: number; description: string };
    expect(call.issueId).toBe(100);
    expect(call.timeSpentSeconds).toBe(7200);
    expect(call.description).toBe("fixed the bug");
  });

  test("two days in file → two createWorklog calls", async () => {
    mockGetWorkingDays.mockResolvedValue([MON, TUE]);
    const file = writeTmp(mkFile(
      { date: MON, entries: ["ABC-1 task one 2h"] },
      { date: TUE, entries: ["ABC-1 task two 3h"] }
    ));

    await logTempo(MON, TUE, { file });

    expect(mockCreateWorklog).toHaveBeenCalledTimes(2);
  });

  test("day not in file is skipped when exact=false prompt=false", async () => {
    mockGetWorkingDays.mockResolvedValue([MON, TUE]);
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 only monday 2h"] }));

    await logTempo(MON, TUE, { file, exact: false, prompt: false });

    expect(mockCreateWorklog).toHaveBeenCalledTimes(1);
  });

  test("no date range: uses dates from file", async () => {
    mockGetWorkingDays.mockResolvedValue([MON]);
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 auto-ranged 4h"] }));

    await logTempo(undefined, undefined, { file });

    expect(mockCreateWorklog).toHaveBeenCalledTimes(1);
  });
});

describe("logTempo file mode — --exact validation", () => {
  test("--exact: file missing a working day → exit(1)", async () => {
    // Range has MON+TUE as working days, file only has MON → missing TUE
    mockGetWorkingDays.mockResolvedValue([MON, TUE]);
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 task 2h"] }));

    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    await expect(logTempo(MON, TUE, { file, exact: true, prompt: false })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("--exact: file has a date that is not a working day → exit(1)", async () => {
    // Range has only MON as a working day; file has MON+TUE (TUE is extra)
    mockGetWorkingDays.mockResolvedValue([MON]);
    const file = writeTmp(mkFile(
      { date: MON, entries: ["ABC-1 task 2h"] },
      { date: TUE, entries: ["ABC-1 extra 1h"] }
    ));

    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    await expect(logTempo(MON, TUE, { file, exact: true, prompt: false })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("--exact without explicit range → exit(1)", async () => {
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 task 2h"] }));

    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    await expect(logTempo(undefined, undefined, { file, exact: true })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("--prompt without explicit range → exit(1)", async () => {
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 task 2h"] }));

    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    await expect(logTempo(undefined, undefined, { file, prompt: true })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe("logTempo file mode — overwrite confirmation", () => {
  test("existing logs + select 'yes' → deleteWorklog then createWorklog", async () => {
    mockGetWorklogsForRange.mockResolvedValue([wl(42, MON, 28_800)]);
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 replacement task 8h"] }));
    mockSelect.mockResolvedValue("yes");
    mockConfirm.mockResolvedValue(true);

    await logTempo(MON, MON, { file });

    expect(mockDeleteWorklog).toHaveBeenCalledTimes(1);
    expect(mockCreateWorklog).toHaveBeenCalledTimes(1);
  });

  test("existing logs + select 'no' → nothing applied", async () => {
    mockGetWorklogsForRange.mockResolvedValue([wl(42, MON, 28_800)]);
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 replacement 8h"] }));
    mockSelect.mockResolvedValueOnce("no");

    await logTempo(MON, MON, { file });

    expect(mockCreateWorklog).not.toHaveBeenCalled();
    expect(mockDeleteWorklog).not.toHaveBeenCalled();
  });
});

describe("logTempo file mode — over/under threshold warnings", () => {
  test("entries under threshold → ⚠ in summary", async () => {
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 short task 6h"] }));
    await logTempo(MON, MON, { file });
    expect(logs.join("\n")).toContain("⚠");
  });

  test("entries over threshold → ⚠ in summary", async () => {
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 long task 10h"] }));
    await logTempo(MON, MON, { file });
    expect(logs.join("\n")).toContain("⚠");
  });

  test("entries exactly matching threshold → ✓, no ⚠", async () => {
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 exact task 8h"] }));
    await logTempo(MON, MON, { file });
    expect(logs.join("\n")).toContain("✓");
    expect(logs.join("\n")).not.toContain("⚠");
  });
});

describe("logTempo file mode — API errors", () => {
  test("getWorklogsForRange rejects → exit(1)", async () => {
    mockGetWorklogsForRange.mockRejectedValue(new Error("tempo fetch error"));
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 task 8h"] }));

    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    await expect(logTempo(MON, MON, { file })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("getIssueIdsByKeys rejects → exit(1)", async () => {
    mockGetIssueIdsByKeys.mockRejectedValue(new Error("jira down"));
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 task 8h"] }));

    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    await expect(logTempo(MON, MON, { file })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("unresolved issue key → exit(1)", async () => {
    mockGetIssueIdsByKeys.mockResolvedValue(new Map()); // ABC-1 not resolvable
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 task 8h"] }));

    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    await expect(logTempo(MON, MON, { file })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("createWorklog rejects → exit(1)", async () => {
    mockCreateWorklog.mockRejectedValue(new Error("tempo create error"));
    const file = writeTmp(mkFile({ date: MON, entries: ["ABC-1 task 8h"] }));

    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    await expect(logTempo(MON, MON, { file })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe("logTempo — option validation", () => {
  test("--file and --stdin together → exit(1)", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("process.exit"); });
    await expect(logTempo(undefined, undefined, { file: "foo.md", stdin: true })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
