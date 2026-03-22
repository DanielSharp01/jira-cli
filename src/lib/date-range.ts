function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function todayDate(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Monday of the week containing d */
function weekStart(d: Date): Date {
  const day = d.getDay(); // 0=Sun
  const mon = new Date(d);
  mon.setDate(d.getDate() - ((day + 6) % 7));
  return mon;
}

/** Last day of the month containing d */
function monthEnd(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

/**
 * Parses a date expression into a Date object (start or end of period).
 *
 * Grammar:
 *   expr    = base | base "-end" | relative | relative "-end"
 *   base    = "today" | "yesterday" | "year" | "month" | "week"
 *   relative= ["-"] N "-" unit | "last-" unit | "next-" unit
 *   unit    = "year" | "month" | "week"
 *
 * Start-of-period examples (today = 2026-03-22):
 *   "year"      → 2026-01-01
 *   "month"     → 2026-03-01
 *   "week"      → 2026-03-16
 *   "today"     → 2026-03-22
 *   "yesterday" → 2026-03-21
 *   "-2-month"  → 2026-01-01  (2 months back from start of current month)
 *   "4-week"    → 2026-04-13  (4 weeks forward from start of current week)
 *   "last-month"→ 2026-02-01  (same as -1-month)
 *   "next-month"→ 2026-04-01  (same as 1-month)
 *
 * Add "-end" suffix to get end of that period:
 *   "month-end" → 2026-03-31
 *   "week-end"  → 2026-03-22 (Sunday)
 *   "year-end"  → 2026-12-31
 *   "2-month-end" → 2026-05-31
 */
export function parseDateExpr(expr: string): Date {
  const today = todayDate();

  // Undo the __neg__ escape applied in index.ts to protect negative offsets from Commander
  const exprNorm = expr.startsWith("__neg__") ? `-${expr.slice(7)}` : expr;

  // Strip "-end" suffix
  let wantEnd = false;
  let raw = exprNorm;
  if (raw.endsWith("-end")) {
    // Make sure it's not e.g. "weekend" — check the prefix is a known expr
    const prefix = raw.slice(0, -4);
    // We'll resolve prefix first, then convert to end-of-period
    wantEnd = true;
    raw = prefix;
  }

  let base: Date;

  if (raw === "today") {
    base = today;
  } else if (raw === "yesterday") {
    base = new Date(today);
    base.setDate(today.getDate() - 1);
  } else if (raw === "year") {
    base = new Date(today.getFullYear(), 0, 1);
  } else if (raw === "month") {
    base = new Date(today.getFullYear(), today.getMonth(), 1);
  } else if (raw === "week") {
    base = weekStart(today);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    base = new Date(`${raw}T12:00:00`);
  } else {
    // Relative: [-]N-unit or last-unit or next-unit
    const relMatch = raw.match(/^(-?\d+)-(year|month|week)$/) ??
                     raw.match(/^(last|next)-(year|month|week)$/);
    if (!relMatch) {
      throw new Error(
        `Invalid date expression "${exprNorm}". Use: today, yesterday, year, month, week, YYYY-MM-DD, ` +
        `[-]N-unit, last-unit, next-unit (unit = year|month|week), or add -end suffix.`
      );
    }

    const [, nOrLastNext, unit] = relMatch as [string, string, string];
    let n: number;
    if (nOrLastNext === "last") n = -1;
    else if (nOrLastNext === "next") n = 1;
    else n = parseInt(nOrLastNext, 10);

    if (unit === "year") {
      base = new Date(today.getFullYear() + n, 0, 1);
    } else if (unit === "month") {
      base = new Date(today.getFullYear(), today.getMonth() + n, 1);
    } else {
      // week: start of current week + n*7 days
      const mon = weekStart(today);
      base = new Date(mon);
      base.setDate(mon.getDate() + n * 7);
    }
  }

  if (!wantEnd) return base;

  // Convert to end-of-period
  if (raw === "today" || raw === "yesterday" || /^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return base; // single day, end = same day
  }

  // Determine unit from raw expr
  let unit: "year" | "month" | "week";
  if (raw === "year" || raw.endsWith("-year") || raw === "last-year" || raw === "next-year") {
    unit = "year";
  } else if (raw === "month" || raw.endsWith("-month") || raw === "last-month" || raw === "next-month") {
    unit = "month";
  } else {
    unit = "week";
  }

  if (unit === "year") {
    return new Date(base.getFullYear(), 11, 31);
  } else if (unit === "month") {
    return monthEnd(base);
  } else {
    // week: base is Monday, end is Sunday (+6)
    const sun = new Date(base);
    sun.setDate(base.getDate() + 6);
    return sun;
  }
}

export function parseDateRange(from?: string, to?: string): { from: string; to: string } {
  const today = toISODate(todayDate());

  if (!from) {
    return { from: today, to: today };
  }

  const fromDate = parseDateExpr(from);
  const fromStr = toISODate(fromDate);

  let toStr: string;
  if (to) {
    toStr = toISODate(parseDateExpr(to));
  } else {
    toStr = today;
    if (fromStr > today) {
      throw new Error(`"${from}" resolves to a future date (${fromStr}). Specify an explicit to date.`);
    }
  }

  if (fromStr > toStr) {
    throw new Error(`Date range is inverted: ${fromStr} > ${toStr}`);
  }

  return { from: fromStr, to: toStr };
}
