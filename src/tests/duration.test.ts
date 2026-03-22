import { describe, test, expect } from "bun:test";
import { parseDuration, formatDuration } from "../lib/duration.ts";

describe("parseDuration", () => {
  test("2h → 7200", () => expect(parseDuration("2h")).toBe(7200));
  test("30m → 1800", () => expect(parseDuration("30m")).toBe(1800));
  test("1h30m → 5400", () => expect(parseDuration("1h30m")).toBe(5400));
  test("1.5h → 5400", () => expect(parseDuration("1.5h")).toBe(5400));
  test("0.5h → 1800", () => expect(parseDuration("0.5h")).toBe(1800));
  test("case insensitive: 2H → 7200", () => expect(parseDuration("2H")).toBe(7200));
  test("whitespace trimmed: ' 1h ' → 3600", () => expect(parseDuration(" 1h ")).toBe(3600));

  test("empty string throws", () => expect(() => parseDuration("")).toThrow());
  test("'bad' throws", () => expect(() => parseDuration("bad")).toThrow());
  test("'h' alone throws", () => expect(() => parseDuration("h")).toThrow());
});

describe("formatDuration", () => {
  test("7200 → '2h'", () => expect(formatDuration(7200)).toBe("2h"));
  test("1800 → '30m'", () => expect(formatDuration(1800)).toBe("30m"));
  test("5400 → '1h30m'", () => expect(formatDuration(5400)).toBe("1h30m"));
  test("90 → '1m'", () => expect(formatDuration(90)).toBe("1m"));
  test("3600 → '1h'", () => expect(formatDuration(3600)).toBe("1h"));
  test("0 → '0m'", () => expect(formatDuration(0)).toBe("0m"));
});
