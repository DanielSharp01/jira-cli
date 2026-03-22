import { describe, test, expect } from "bun:test";
import { parseEntryLine } from "../cli/tempo/log.ts";

describe("parseEntryLine — happy paths", () => {
  test("standard order: key description duration", () => {
    const r = parseEntryLine("ABC-123 fix the thing 2h");
    expect(r).toEqual({ issueKey: "ABC-123", durationSeconds: 7200, description: "fix the thing" });
  });

  test("duration first", () => {
    const r = parseEntryLine("2h ABC-123 fix the thing");
    expect(r).toEqual({ issueKey: "ABC-123", durationSeconds: 7200, description: "fix the thing" });
  });

  test("description first", () => {
    const r = parseEntryLine("fix the thing ABC-123 2h");
    expect(r).toEqual({ issueKey: "ABC-123", durationSeconds: 7200, description: "fix the thing" });
  });

  test("leading dash stripped", () => {
    const r = parseEntryLine("- ABC-123 fix the thing 2h");
    expect(r).toEqual({ issueKey: "ABC-123", durationSeconds: 7200, description: "fix the thing" });
  });

  test("dash separators between sections", () => {
    const r = parseEntryLine("- ABC-123 - fix the thing - 2h");
    expect(r).toEqual({ issueKey: "ABC-123", durationSeconds: 7200, description: "fix the thing" });
  });

  test("multiple dashes as separators", () => {
    const r = parseEntryLine("--ABC-123--fix the thing--2h");
    expect(r.issueKey).toBe("ABC-123");
    expect(r.durationSeconds).toBe(7200);
  });

  test("1h30m duration", () => {
    const r = parseEntryLine("ABC-123 fix 1h30m");
    expect(r.durationSeconds).toBe(5400);
  });

  test("decimal duration 1.5h", () => {
    const r = parseEntryLine("ABC-123 fix 1.5h");
    expect(r.durationSeconds).toBe(5400);
  });

  test("multiple issue keys: first wins, rest in description", () => {
    const r = parseEntryLine("ABC-123 DEF-456 regression 2h");
    expect(r.issueKey).toBe("ABC-123");
    expect(r.durationSeconds).toBe(7200);
    expect(r.description).toContain("DEF-456");
  });

  test("multiple durations: first wins, rest in description", () => {
    const r = parseEntryLine("ABC-123 2h 3h ambiguous");
    expect(r.issueKey).toBe("ABC-123");
    expect(r.durationSeconds).toBe(7200);
    expect(r.description).toContain("3h");
    expect(r.description).toContain("ambiguous");
  });

  test("lowercase key project not matched as issue key", () => {
    expect(() => parseEntryLine("abc-123 fix 2h")).toThrow("no issue key found");
  });
});

describe("parseEntryLine — error paths", () => {
  test("no issue key → throws", () => {
    expect(() => parseEntryLine("no key here 2h")).toThrow("no issue key found");
  });

  test("no duration → throws", () => {
    expect(() => parseEntryLine("ABC-123 no duration here")).toThrow("no duration found");
  });

  test("key and duration only, no description → throws", () => {
    expect(() => parseEntryLine("ABC-123 2h")).toThrow("no description found");
  });

  test("empty string → throws", () => {
    expect(() => parseEntryLine("")).toThrow();
  });
});
