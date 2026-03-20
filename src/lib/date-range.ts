function toISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function parseDateRange(from?: string, to?: string): { from: string; to: string } {
  const today = toISODate(new Date());

  if (!from) {
    return { from: today, to: today };
  }

  if (from === "week") {
    const now = new Date();
    const day = now.getDay(); // 0=Sun
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((day + 6) % 7));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return { from: toISODate(mon), to: toISODate(sun) };
  }

  if (from === "month") {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const resolvedTo = to === "today" ? today : (to ?? toISODate(last));
    return { from: toISODate(first), to: resolvedTo };
  }

  if (from === "today") {
    return { from: today, to: today };
  }

  const resolveDate = (d: string) => (d === "today" ? today : d);

  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    if (to) {
      const resolvedTo = resolveDate(to);
      if (/^\d{4}-\d{2}-\d{2}$/.test(resolvedTo)) return { from, to: resolvedTo };
    }
    return { from, to: from };
  }

  throw new Error(`Invalid date/range "${from}". Use YYYY-MM-DD, "today", "week", or "month".`);
}
