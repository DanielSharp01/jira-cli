import { describe, test, expect, beforeAll, afterAll, jest } from "bun:test";
import { parseDateExpr, parseDateRange } from "../lib/date-range.ts";

// Fix system time to a known Sunday so relative expressions are deterministic.
// 2026-03-22 is a Sunday.
beforeAll(() => jest.setSystemTime(new Date("2026-03-22T12:00:00")));
afterAll(() => jest.useRealTimers());

describe("parseDateExpr — base expressions", () => {
  test("today", () => expect(parseDateExpr("today").toISOString().slice(0, 10)).toBe("2026-03-22"));
  test("yesterday", () => expect(parseDateExpr("yesterday").toISOString().slice(0, 10)).toBe("2026-03-21"));
  test("year → Jan 1", () => expect(parseDateExpr("year").toISOString().slice(0, 10)).toBe("2026-01-01"));
  test("month → Mar 1", () => expect(parseDateExpr("month").toISOString().slice(0, 10)).toBe("2026-03-01"));
  test("week → Monday Mar 16", () => expect(parseDateExpr("week").toISOString().slice(0, 10)).toBe("2026-03-16"));

  test("explicit ISO date", () => expect(parseDateExpr("2025-06-15").toISOString().slice(0, 10)).toBe("2025-06-15"));
  test("invalid expression throws", () => expect(() => parseDateExpr("foobar")).toThrow());
});

describe("parseDateExpr — -end suffix", () => {
  test("year-end → Dec 31", () => expect(parseDateExpr("year-end").toISOString().slice(0, 10)).toBe("2026-12-31"));
  test("month-end → Mar 31", () => expect(parseDateExpr("month-end").toISOString().slice(0, 10)).toBe("2026-03-31"));
  test("week-end → Sunday Mar 22", () => expect(parseDateExpr("week-end").toISOString().slice(0, 10)).toBe("2026-03-22"));
  test("today-end → same day", () => expect(parseDateExpr("today-end").toISOString().slice(0, 10)).toBe("2026-03-22"));
  test("2-month-end → May 31", () => expect(parseDateExpr("2-month-end").toISOString().slice(0, 10)).toBe("2026-05-31"));
  test("last-month-end → Feb 28", () => expect(parseDateExpr("last-month-end").toISOString().slice(0, 10)).toBe("2026-02-28"));
});

describe("parseDateExpr — relative expressions", () => {
  test("last-month → Feb 1", () => expect(parseDateExpr("last-month").toISOString().slice(0, 10)).toBe("2026-02-01"));
  test("next-month → Apr 1", () => expect(parseDateExpr("next-month").toISOString().slice(0, 10)).toBe("2026-04-01"));
  test("last-year → Jan 1 2025", () => expect(parseDateExpr("last-year").toISOString().slice(0, 10)).toBe("2025-01-01"));
  test("next-year → Jan 1 2027", () => expect(parseDateExpr("next-year").toISOString().slice(0, 10)).toBe("2027-01-01"));
  test("last-week → Mon Mar 9", () => expect(parseDateExpr("last-week").toISOString().slice(0, 10)).toBe("2026-03-09"));
  test("next-week → Mon Mar 23", () => expect(parseDateExpr("next-week").toISOString().slice(0, 10)).toBe("2026-03-23"));

  // These use the __neg__ escape that index.ts applies before Commander parsing
  test("-2-month (via __neg__) → Jan 1", () => expect(parseDateExpr("__neg__2-month").toISOString().slice(0, 10)).toBe("2026-01-01"));
  test("-1-week (via __neg__) → Mon Mar 9", () => expect(parseDateExpr("__neg__1-week").toISOString().slice(0, 10)).toBe("2026-03-09"));
  test("4-week → Mon Apr 13", () => expect(parseDateExpr("4-week").toISOString().slice(0, 10)).toBe("2026-04-13"));
  test("2-month → May 1", () => expect(parseDateExpr("2-month").toISOString().slice(0, 10)).toBe("2026-05-01"));
});

describe("parseDateRange", () => {
  test("no args → today/today", () => {
    expect(parseDateRange()).toEqual({ from: "2026-03-22", to: "2026-03-22" });
  });

  test("'month' only → start of month to today", () => {
    expect(parseDateRange("month")).toEqual({ from: "2026-03-01", to: "2026-03-22" });
  });

  test("'month', 'month-end' → full month", () => {
    expect(parseDateRange("month", "month-end")).toEqual({ from: "2026-03-01", to: "2026-03-31" });
  });

  test("explicit dates", () => {
    expect(parseDateRange("2026-01-01", "2026-01-31")).toEqual({ from: "2026-01-01", to: "2026-01-31" });
  });

  test("future from with no to → throws", () => {
    expect(() => parseDateRange("next-month")).toThrow("future date");
  });

  test("inverted range → throws", () => {
    expect(() => parseDateRange("2026-03-31", "2026-03-01")).toThrow("inverted");
  });
});
