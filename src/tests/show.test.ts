import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import type { TempoWorklog } from "../lib/types.ts";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before importing the module under test.
// Bun hoists mock.module() calls before static imports.
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
mock.module("../lib/tempo.ts", () => ({
  getWorklogsForRange: mockGetWorklogsForRange,
  getWorkingDays: mockGetWorkingDays,
}));

const mockGetIssueKeysByIds = mock(async (): Promise<Map<number, string>> => new Map());
mock.module("../lib/jira.ts", () => ({
  getIssueKeysByIds: mockGetIssueKeysByIds,
}));

// Strip color codes so assertions can match plain text
mock.module("picocolors", () => ({
  default: {
    bold: (s: string) => s,
    green: (s: string) => s,
    cyan: (s: string) => s,
    dim: (s: string) => s,
    yellow: (s: string) => s,
    red: (s: string) => s,
  },
}));

const mockSpinner = { start: mock(() => {}), stop: mock(() => {}) };
const mockLogError = mock((_msg: string) => {});
const mockLogWarn = mock((_msg: string) => {});
mock.module("@clack/prompts", () => ({
  spinner: () => mockSpinner,
  log: { error: mockLogError, warn: mockLogWarn },
}));

import { showTempo } from "../cli/tempo/show.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wl(id: number, date: string, secs: number, desc = "task"): TempoWorklog {
  return {
    tempoWorklogId: id,
    issue: { id: 10 },
    timeSpentSeconds: secs,
    startDate: date,
    startTime: "09:00:00",
    description: desc,
    author: { accountId: "acc1" },
  };
}

const MON = "2026-03-16";
const TUE = "2026-03-17";

// Capture console.log output per test
let logs: string[];

beforeEach(() => {
  logs = [];
  spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  mockGetWorklogsForRange.mockReset();
  mockGetWorkingDays.mockReset();
  mockGetIssueKeysByIds.mockReset();
  mockGetIssueKeysByIds.mockResolvedValue(new Map([[10, "ABC-1"]]));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("showTempo — display filtering", () => {
  test("--days=working shows all working days regardless of logged hours", async () => {
    mockGetWorklogsForRange.mockResolvedValue([wl(1, MON, 28800)]);
    mockGetWorkingDays.mockResolvedValue([MON, TUE]);

    await showTempo(MON, TUE, { days: "working" });

    const joined = logs.join("\n");
    expect(joined).toContain("Monday");
    expect(joined).toContain("Tuesday");
  });

  test("--days=unlogged (default) hides fully logged days", async () => {
    // MON = 8h (fully logged), TUE = 4h (under threshold)
    mockGetWorklogsForRange.mockResolvedValue([
      wl(1, MON, 28800),
      wl(2, TUE, 14400),
    ]);
    mockGetWorkingDays.mockResolvedValue([MON, TUE]);

    await showTempo(MON, TUE); // default --days=unlogged

    const joined = logs.join("\n");
    expect(joined).not.toContain("Monday");
    expect(joined).toContain("Tuesday");
  });

  test("--days=no-logs shows only days with zero logs", async () => {
    mockGetWorklogsForRange.mockResolvedValue([wl(1, MON, 28800)]);
    mockGetWorkingDays.mockResolvedValue([MON, TUE]);

    await showTempo(MON, TUE, { days: "no-logs" });

    const joined = logs.join("\n");
    expect(joined).not.toContain("Monday");
    expect(joined).toContain("Tuesday");
  });

  test("empty result produces no output", async () => {
    mockGetWorklogsForRange.mockResolvedValue([]);
    mockGetWorkingDays.mockResolvedValue([]);

    await showTempo(MON, TUE, { days: "working" });

    expect(logs.filter(l => l.includes("Monday") || l.includes("Tuesday"))).toHaveLength(0);
  });
});

describe("showTempo — --short format", () => {
  test("prints day: logged/threshold per line", async () => {
    mockGetWorklogsForRange.mockResolvedValue([wl(1, MON, 14400)]);
    mockGetWorkingDays.mockResolvedValue([MON]);

    await showTempo(MON, MON, { days: "working", short: true });

    expect(logs.some(l => l.includes("4h/8h"))).toBe(true);
  });

  test("shows 0h for day with no logs", async () => {
    mockGetWorklogsForRange.mockResolvedValue([]);
    mockGetWorkingDays.mockResolvedValue([MON]);

    await showTempo(MON, MON, { days: "working", short: true });

    expect(logs.some(l => l.includes("0h/8h"))).toBe(true);
  });

  test("respects custom --logged threshold", async () => {
    mockGetWorklogsForRange.mockResolvedValue([wl(1, MON, 14400)]);
    mockGetWorkingDays.mockResolvedValue([MON]);

    await showTempo(MON, MON, { days: "working", short: true, logged: "6h" });

    expect(logs.some(l => l.includes("4h/6h"))).toBe(true);
  });
});

describe("showTempo — --stdout markdown output", () => {
  test("writes markdown with weekday in header", async () => {
    mockGetWorklogsForRange.mockResolvedValue([wl(1, MON, 7200, "my task")]);
    mockGetWorkingDays.mockResolvedValue([MON]);

    const written: string[] = [];
    spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    await showTempo(MON, MON, { days: "working", stdout: true });

    const output = written.join("");
    expect(output).toContain("# 2026-03-16 (Monday)");
    expect(output).toContain("ABC-1");
    expect(output).toContain("my task");
  });
});

describe("showTempo — issue key resolution", () => {
  test("uses resolved issue key in output", async () => {
    mockGetIssueKeysByIds.mockResolvedValue(new Map([[10, "XYZ-99"]]));
    mockGetWorklogsForRange.mockResolvedValue([wl(1, MON, 14400)]);
    mockGetWorkingDays.mockResolvedValue([MON]);

    await showTempo(MON, MON, { days: "working" });

    expect(logs.join("\n")).toContain("XYZ-99");
  });
});

describe("showTempo — error paths", () => {
  test("getWorklogsForRange rejects → process.exit(1)", async () => {
    mockGetWorklogsForRange.mockRejectedValue(new Error("Tempo error"));
    mockGetWorkingDays.mockResolvedValue([MON]);

    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(showTempo(MON, MON, { days: "working" })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("getWorkingDays rejects → process.exit(1)", async () => {
    mockGetWorklogsForRange.mockResolvedValue([]);
    mockGetWorkingDays.mockRejectedValue(new Error("schedule error"));

    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(showTempo(MON, MON, { days: "working" })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("invalid --logged value → process.exit(1)", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(showTempo(MON, MON, { logged: "notaduration" })).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("invalid date expression → process.exit(1)", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    await expect(showTempo("not-a-date")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  test("future from without to → process.exit(1)", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    // next-month is in the future and has no explicit to
    await expect(showTempo("next-month")).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
