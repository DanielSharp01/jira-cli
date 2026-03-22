import * as p from "@clack/prompts";
import pc from "picocolors";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ListItem<T> {
  label: string;
  value: T;
  separator?: boolean;
}

export interface ColDef<T> {
  key: string;
  header: string;
  render: (row: T) => string;
  minWidth?: number;
  defaultVisible?: boolean;
  sortable?: boolean;
}

export interface SortState {
  colKey: string;
  dir: "asc" | "desc";
}

export type TableResult<T> =
  | { action: "open"; item: T; cursorIndex: number; sortState: SortState[]; visibleCols: string[] }
  | { action: "filter" | "sort"; cursorIndex: number; sortState: SortState[]; visibleCols: string[] }
  | { action: "exit" };

export interface GroupByOpts<T> {
  getId: (row: T) => string;
  getParentId: (row: T) => string | undefined;
}

export interface TablePickerOpts<T = unknown> {
  initialCursor?: number;
  initialSort?: SortState[];
  initialVisibleCols?: string[];
  groupBy?: GroupByOpts<T>;
  hasMore?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sprintDateRange(startDate?: string, endDate?: string): string {
  if (!startDate && !endDate) return "";
  const fmtStart = (d: string) => {
    const dt = new Date(d);
    return `${dt.getFullYear()} ${dt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  };
  const fmtEnd = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (startDate && endDate) return `(${fmtStart(startDate)} – ${fmtEnd(endDate)})`;
  if (startDate) return `(${fmtStart(startDate)})`;
  return `(${fmtEnd(endDate!)})`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return `${str.slice(0, maxLen - 1)}…`;
}

function pad(str: string, width: number): string {
  return str.length >= width ? str : str + " ".repeat(width - str.length);
}

function sortRows<T>(rows: T[], colDefs: ColDef<T>[], sortState: SortState[]): T[] {
  if (sortState.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const s of sortState) {
      const col = colDefs.find((c) => c.key === s.colKey);
      if (!col) continue;
      // numeric: true handles Jira keys like TTR-413 < TTR-1329 correctly
      const cmp = col.render(a).localeCompare(col.render(b), undefined, { numeric: true });
      if (cmp !== 0) return s.dir === "asc" ? cmp : -cmp;
    }
    return 0;
  });
}

interface DisplayRow<T> { row: T; indent: number }

function buildDisplayRows<T>(
  rows: T[],
  colDefs: ColDef<T>[],
  sortState: SortState[],
  groupBy?: GroupByOpts<T>
): DisplayRow<T>[] {
  if (!groupBy) {
    return sortRows(rows, colDefs, sortState).map((row) => ({ row, indent: 0 }));
  }
  const idSet = new Set(rows.map(groupBy.getId));
  const topLevel: T[] = [];
  const childrenMap = new Map<string, T[]>();
  for (const r of rows) {
    const pid = groupBy.getParentId(r);
    if (pid && idSet.has(pid)) {
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid)!.push(r);
    } else {
      topLevel.push(r);
    }
  }
  const result: DisplayRow<T>[] = [];
  const gb = groupBy;
  function walk(items: T[], indent: number) {
    for (const item of sortRows(items, colDefs, sortState)) {
      result.push({ row: item, indent });
      const children = childrenMap.get(gb.getId(item));
      if (children) walk(children, indent + 1);
    }
  }
  walk(topLevel, 0);
  return result;
}

// Default column widths (overridden by ColDef.minWidth)
const DEFAULT_COL_W: Record<string, number> = {
  key: 13, type: 10, status: 22, sprint: 16, estimate: 8, summary: 58,
};

function renderRowLabel<T>(dr: DisplayRow<T>, colDefs: ColDef<T>[], visibleCols: string[]): string {
  const prefix = dr.indent > 0 ? `${"  ".repeat(dr.indent - 1)}↳ ` : "";

  // key is always first
  const keyCol = colDefs.find((c) => c.key === "key");
  const rawKey = keyCol?.render(dr.row) ?? "";
  const keyW = keyCol?.minWidth ?? DEFAULT_COL_W["key"]!;
  const parts: string[] = [pad(truncate(`${prefix}${rawKey}`, keyW), keyW)];

  // middle columns (everything visible except key and summary), in visibleCols order
  for (const key of visibleCols) {
    if (key === "key" || key === "summary") continue;
    const col = colDefs.find((c) => c.key === key);
    if (!col) continue;
    const w = col.minWidth ?? DEFAULT_COL_W[key] ?? 12;
    parts.push(pad(truncate(col.render(dr.row), w), w));
  }

  // summary always last, no padding
  if (visibleCols.includes("summary")) {
    const col = colDefs.find((c) => c.key === "summary");
    if (col) {
      const w = col.minWidth ?? DEFAULT_COL_W["summary"]!;
      parts.push(truncate(col.render(dr.row), w));
    }
  }

  return parts.join("  ");
}

// ---------------------------------------------------------------------------
// runListPicker
// ---------------------------------------------------------------------------

export async function runListPicker<T>(
  title: string,
  items: ListItem<T>[]
): Promise<T | null> {
  let filter = "";

  while (true) {
    const filtered = filter
      ? items.filter((i) => i.separator || i.label.toLowerCase().includes(filter.toLowerCase()))
      : items;

    type Opt = { value: string; label: string; hint?: string };
    const options: Opt[] = [
      { value: "__filter__", label: filter ? `🔍  Filter: "${filter}"` : "🔍  Filter by name" },
    ];

    let sepIdx = 0;
    for (const item of filtered) {
      if (item.separator) {
        options.push({ value: `__sep_${sepIdx++}__`, label: pc.dim(item.label) });
      } else {
        options.push({ value: JSON.stringify(item.value), label: item.label });
      }
    }

    const picked = await p.select({ message: title, options }) as string | symbol;
    if (p.isCancel(picked)) return null;

    if (picked === "__filter__") {
      const val = await p.text({ message: "Filter by name:", initialValue: filter, placeholder: "leave empty to clear" });
      if (!p.isCancel(val)) filter = val.trim();
      continue;
    }

    if ((picked as string).startsWith("__sep_")) continue; // separator clicked — loop

    // Deserialise
    const item = items.find((i) => JSON.stringify(i.value) === picked);
    if (item && !item.separator) return item.value;
  }
}

// ---------------------------------------------------------------------------
// runTablePicker
// ---------------------------------------------------------------------------

export async function runTablePicker<T>(
  title: string,
  colDefs: ColDef<T>[],
  rows: T[],
  opts: TablePickerOpts<T> = {}
): Promise<TableResult<T>> {
  const visibleCols = opts.initialVisibleCols
    ?? colDefs.filter((c) => c.defaultVisible !== false).map((c) => c.key);
  const sortState  = opts.initialSort ?? [];
  const cursor     = opts.initialCursor ?? 0;

  const displayRows = buildDisplayRows(rows, colDefs, sortState, opts.groupBy);

  const countHint = `${displayRows.length}${opts.hasMore ? "+" : ""} issues`;
  const sortHint  = sortState.length > 0
    ? "  " + pc.dim(sortState.map((s) => `${s.colKey} ${s.dir === "asc" ? "▲" : "▼"}`).join(", "))
    : "";

  type Opt = { value: string; label: string };
  const options: Opt[] = [
    { value: "__filter__", label: "🔍  Change filters" },
    { value: "__sort__",   label: `↕   Change sort${sortHint}` },
    { value: "__exit__",   label: "←   Back" },
  ];

  for (let i = 0; i < displayRows.length; i++) {
    options.push({
      value: `__row__${i}`,
      label: renderRowLabel(displayRows[i]!, colDefs, visibleCols),
    });
  }

  const initialValue = cursor < displayRows.length ? `__row__${cursor}` : "__row__0";

  const picked = await p.select({
    message: `${title}  ${pc.dim(countHint)}`,
    options,
    initialValue,
  }) as string | symbol;

  if (p.isCancel(picked)) return { action: "exit" };

  if (picked === "__filter__") return { action: "filter", cursorIndex: cursor, sortState, visibleCols };
  if (picked === "__sort__")   return { action: "sort",   cursorIndex: cursor, sortState, visibleCols };
  if (picked === "__exit__")   return { action: "exit" };

  const rowIdx = parseInt((picked as string).replace("__row__", ""), 10);
  const dr = displayRows[rowIdx];
  if (!dr) return { action: "exit" };

  return { action: "open", item: dr.row, cursorIndex: rowIdx, sortState, visibleCols };
}
