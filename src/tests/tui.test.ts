import { describe, test, expect, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — hoisted before imports
// ---------------------------------------------------------------------------

const CANCEL = Symbol.for("clack/cancel");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSelect = mock(async (_args: any): Promise<any> => "__exit__");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockText   = mock(async (_args: any): Promise<any> => "");

mock.module("@clack/prompts", () => ({
  select:   mockSelect,
  text:     mockText,
  isCancel: (v: unknown) => v === CANCEL,
}));

mock.module("picocolors", () => ({
  default: { dim: (s: string) => s, green: (s: string) => s },
}));

import {
  runListPicker,
  runTablePicker,
  sprintDateRange,
  type ColDef,
  type SortState,
  type ListItem,
} from "../lib/tui.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Row { id: string; type: string; status: string; summary: string }

const COL_DEFS: ColDef<Row>[] = [
  { key: "key",     header: "KEY",     render: (r) => r.id,      defaultVisible: true,  sortable: true  },
  { key: "type",    header: "TYPE",    render: (r) => r.type,    defaultVisible: true,  sortable: true  },
  { key: "status",  header: "STATUS",  render: (r) => r.status,  defaultVisible: true,  sortable: true  },
  { key: "summary", header: "SUMMARY", render: (r) => r.summary, defaultVisible: true,  sortable: false },
];

function makeRow(id: string, type = "Story", status = "To Do", summary = `Summary ${id}`): Row {
  return { id, type, status, summary };
}

/** Capture the options array passed to the next p.select call, then resolve with `returnValue`. */
function captureAndReturn(returnValue: string) {
  return new Promise<{ value: string; label: string }[]>((resolve) => {
    mockSelect.mockImplementationOnce(async ({ options }: { options: { value: string; label: string }[] }) => {
      resolve(options);
      return returnValue;
    });
  });
}

beforeEach(() => {
  mockSelect.mockReset();
  mockText.mockReset();
  mockSelect.mockResolvedValue("__exit__");
  mockText.mockResolvedValue("");
});

// ---------------------------------------------------------------------------
// sprintDateRange
// ---------------------------------------------------------------------------

describe("sprintDateRange", () => {
  test("returns empty string with no dates", () => {
    expect(sprintDateRange()).toBe("");
  });

  test("formats a date range", () => {
    const result = sprintDateRange("2026-03-10", "2026-03-24");
    expect(result).toContain("Mar 10");
    expect(result).toContain("Mar 24");
    expect(result).toMatch(/\(.*–.*\)/);
  });

  test("single start date", () => {
    const result = sprintDateRange("2026-03-10");
    expect(result).toContain("Mar 10");
    expect(result).toMatch(/^\(/);
  });
});

// ---------------------------------------------------------------------------
// runTablePicker — action items
// ---------------------------------------------------------------------------

describe("runTablePicker — actions", () => {
  test("returns exit when __exit__ is selected", async () => {
    mockSelect.mockResolvedValueOnce("__exit__");
    const result = await runTablePicker("Issues", COL_DEFS, [makeRow("P-1")]);
    expect(result.action).toBe("exit");
  });

  test("returns exit on cancel", async () => {
    mockSelect.mockResolvedValueOnce(CANCEL);
    const result = await runTablePicker("Issues", COL_DEFS, [makeRow("P-1")]);
    expect(result.action).toBe("exit");
  });

  test("returns filter action", async () => {
    mockSelect.mockResolvedValueOnce("__filter__");
    const result = await runTablePicker("Issues", COL_DEFS, [makeRow("P-1")]);
    expect(result.action).toBe("filter");
  });

  test("returns sort action", async () => {
    mockSelect.mockResolvedValueOnce("__sort__");
    const result = await runTablePicker("Issues", COL_DEFS, [makeRow("P-1")]);
    expect(result.action).toBe("sort");
  });

  test("filter/sort results carry cursorIndex, sortState, visibleCols", async () => {
    const sort: SortState[] = [{ colKey: "status", dir: "asc" }];
    mockSelect.mockResolvedValueOnce("__filter__");
    const result = await runTablePicker("Issues", COL_DEFS, [makeRow("P-1")], {
      initialCursor: 2,
      initialSort: sort,
      initialVisibleCols: ["key", "summary"],
    });
    if (result.action === "filter") {
      expect(result.cursorIndex).toBe(2);
      expect(result.sortState).toEqual(sort);
      expect(result.visibleCols).toEqual(["key", "summary"]);
    } else {
      throw new Error("Expected filter action");
    }
  });
});

// ---------------------------------------------------------------------------
// runTablePicker — row selection
// ---------------------------------------------------------------------------

describe("runTablePicker — row selection", () => {
  test("returns open action with first row", async () => {
    const rows = [makeRow("P-1"), makeRow("P-2")];
    mockSelect.mockResolvedValueOnce("__row__0");
    const result = await runTablePicker("Issues", COL_DEFS, rows);
    if (result.action !== "open") throw new Error("Expected open");
    expect(result.item.id).toBe("P-1");
    expect(result.cursorIndex).toBe(0);
  });

  test("returns open action with second row", async () => {
    const rows = [makeRow("P-1"), makeRow("P-2")];
    mockSelect.mockResolvedValueOnce("__row__1");
    const result = await runTablePicker("Issues", COL_DEFS, rows);
    if (result.action !== "open") throw new Error("Expected open");
    expect(result.item.id).toBe("P-2");
    expect(result.cursorIndex).toBe(1);
  });

  test("row labels contain the rendered key and status", async () => {
    const captureP = captureAndReturn("__exit__");
    runTablePicker("Issues", COL_DEFS, [makeRow("PROJ-1", "Story", "In Progress")]);
    const options = await captureP;
    const rowOpt = options.find((o) => o.value === "__row__0");
    expect(rowOpt).toBeDefined();
    expect(rowOpt!.label).toContain("PROJ-1");
    expect(rowOpt!.label).toContain("In Progress");
  });
});

// ---------------------------------------------------------------------------
// runTablePicker — sort
// ---------------------------------------------------------------------------

describe("runTablePicker — sort", () => {
  test("numeric key sort: PROJ-5 < PROJ-413 < PROJ-1329 ascending", async () => {
    const rows = [makeRow("PROJ-1329"), makeRow("PROJ-413"), makeRow("PROJ-5")];
    const captureP = captureAndReturn("__exit__");
    runTablePicker("Issues", COL_DEFS, rows, {
      initialSort: [{ colKey: "key", dir: "asc" }],
    });
    const options = await captureP;
    const rowOpts = options.filter((o) => o.value.startsWith("__row__"));
    expect(rowOpts[0]!.label).toContain("PROJ-5");
    expect(rowOpts[1]!.label).toContain("PROJ-413");
    expect(rowOpts[2]!.label).toContain("PROJ-1329");
  });

  test("numeric key sort descending reverses order", async () => {
    const rows = [makeRow("PROJ-1"), makeRow("PROJ-20"), makeRow("PROJ-3")];
    const captureP = captureAndReturn("__exit__");
    runTablePicker("Issues", COL_DEFS, rows, {
      initialSort: [{ colKey: "key", dir: "desc" }],
    });
    const options = await captureP;
    const rowOpts = options.filter((o) => o.value.startsWith("__row__"));
    expect(rowOpts[0]!.label).toContain("PROJ-20");
    expect(rowOpts[1]!.label).toContain("PROJ-3");
    expect(rowOpts[2]!.label).toContain("PROJ-1");
  });

  test("sort hint appears in sort option label when sort is active", async () => {
    const captureP = captureAndReturn("__exit__");
    runTablePicker("Issues", COL_DEFS, [makeRow("P-1")], {
      initialSort: [{ colKey: "status", dir: "asc" }],
    });
    const options = await captureP;
    const sortOpt = options.find((o) => o.value === "__sort__");
    expect(sortOpt!.label).toContain("▲");
  });
});

// ---------------------------------------------------------------------------
// runTablePicker — hasMore & groupBy
// ---------------------------------------------------------------------------

describe("runTablePicker — hasMore", () => {
  test("count hint shows + when hasMore is true", async () => {
    let capturedMessage = "";
    mockSelect.mockImplementationOnce(async ({ message }: { message: string }) => {
      capturedMessage = message;
      return "__exit__";
    });
    await runTablePicker("Issues", COL_DEFS, [makeRow("P-1")], { hasMore: true });
    expect(capturedMessage).toContain("1+");
  });

  test("count hint has no + when hasMore is false", async () => {
    let capturedMessage = "";
    mockSelect.mockImplementationOnce(async ({ message }: { message: string }) => {
      capturedMessage = message;
      return "__exit__";
    });
    await runTablePicker("Issues", COL_DEFS, [makeRow("P-1")], { hasMore: false });
    expect(capturedMessage).not.toContain("+");
    expect(capturedMessage).toContain("1 ");
  });
});

describe("runTablePicker — groupBy", () => {
  interface GRow { id: string; type: string; status: string; summary: string; parentId?: string }
  const gCols: ColDef<GRow>[] = [
    { key: "key",     header: "KEY",     render: (r) => r.id,      defaultVisible: true },
    { key: "summary", header: "SUMMARY", render: (r) => r.summary, defaultVisible: true },
  ];

  test("child rows appear after parent with ↳ prefix", async () => {
    const parent: GRow = { id: "P-1", type: "Story",   status: "To Do", summary: "Parent" };
    const child:  GRow = { id: "P-2", type: "Subtask", status: "To Do", summary: "Child", parentId: "P-1" };
    const captureP = captureAndReturn("__exit__");
    runTablePicker("Issues", gCols, [child, parent], {
      groupBy: { getId: (r) => r.id, getParentId: (r) => r.parentId },
    });
    const options = await captureP;
    const rowOpts = options.filter((o) => o.value.startsWith("__row__"));
    expect(rowOpts[0]!.label).not.toContain("↳");
    expect(rowOpts[0]!.label).toContain("P-1");
    expect(rowOpts[1]!.label).toContain("↳");
    expect(rowOpts[1]!.label).toContain("P-2");
  });

  test("child rows are returned with correct item on open", async () => {
    const parent: GRow = { id: "P-1", type: "Story",   status: "To Do", summary: "Parent" };
    const child:  GRow = { id: "P-2", type: "Subtask", status: "To Do", summary: "Child", parentId: "P-1" };
    // After groupBy, __row__1 is the child
    mockSelect.mockResolvedValueOnce("__row__1");
    const result = await runTablePicker("Issues", gCols, [child, parent], {
      groupBy: { getId: (r) => r.id, getParentId: (r) => r.parentId },
    });
    if (result.action !== "open") throw new Error("Expected open");
    expect(result.item.id).toBe("P-2");
  });
});

// ---------------------------------------------------------------------------
// runListPicker
// ---------------------------------------------------------------------------

describe("runListPicker", () => {
  test("returns selected item value", async () => {
    const items: ListItem<string>[] = [
      { value: "a", label: "Item A" },
      { value: "b", label: "Item B" },
    ];
    mockSelect.mockResolvedValueOnce(JSON.stringify("a"));
    const result = await runListPicker("Pick:", items);
    expect(result).toBe("a");
  });

  test("returns null on cancel", async () => {
    const items: ListItem<string>[] = [{ value: "a", label: "Item A" }];
    mockSelect.mockResolvedValueOnce(CANCEL);
    const result = await runListPicker("Pick:", items);
    expect(result).toBeNull();
  });

  test("filter: filters items by label and returns matching item", async () => {
    const items: ListItem<string>[] = [
      { value: "apple",   label: "Apple" },
      { value: "banana",  label: "Banana" },
      { value: "apricot", label: "Apricot" },
    ];
    // First call: pick __filter__
    mockSelect.mockResolvedValueOnce("__filter__");
    // Text prompt returns "ap"
    mockText.mockResolvedValueOnce("ap");
    // Second call (filtered list): pick Apricot
    let secondOptions: { value: string; label: string }[] = [];
    mockSelect.mockImplementationOnce(async ({ options }: { options: { value: string; label: string }[] }) => {
      secondOptions = options;
      return JSON.stringify("apricot");
    });

    const result = await runListPicker("Pick:", items);
    expect(result).toBe("apricot");
    // Banana should not appear in filtered options
    const labels = secondOptions.map((o) => o.label);
    expect(labels.some((l) => l.includes("Banana"))).toBe(false);
    expect(labels.some((l) => l.includes("Apple"))).toBe(true);
    expect(labels.some((l) => l.includes("Apricot"))).toBe(true);
  });

  test("separator items are skipped when picked", async () => {
    const items: ListItem<string>[] = [
      { value: "a",     label: "Item A" },
      { value: "__s__", label: "──────", separator: true },
      { value: "b",     label: "Item B" },
    ];
    // First call returns the separator sentinel
    mockSelect.mockResolvedValueOnce("__sep_0__");
    // Second call returns item B
    mockSelect.mockResolvedValueOnce(JSON.stringify("b"));
    const result = await runListPicker("Pick:", items);
    expect(result).toBe("b");
  });

  test("all items are present in options", async () => {
    const items: ListItem<string>[] = [
      { value: "x", label: "Item X" },
      { value: "y", label: "Item Y" },
    ];
    const captureP = new Promise<{ value: string; label: string }[]>((resolve) => {
      mockSelect.mockImplementationOnce(async ({ options }: { options: { value: string; label: string }[] }) => {
        resolve(options);
        return CANCEL;
      });
    });
    runListPicker("Pick:", items);
    const options = await captureP;
    const labels = options.map((o) => o.label);
    expect(labels).toContain("Item X");
    expect(labels).toContain("Item Y");
    // Filter option always present
    expect(options.some((o) => o.value === "__filter__")).toBe(true);
  });
});
