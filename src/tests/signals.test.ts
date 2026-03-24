import { describe, test, expect } from "bun:test";
import { extractIssueKeys } from "../lib/signals.ts";

describe("extractIssueKeys", () => {
  test("extracts single key from commit message", () => {
    expect(extractIssueKeys("Fix ABC-123 login bug")).toEqual(["ABC-123"]);
  });

  test("extracts multiple keys", () => {
    expect(extractIssueKeys("ABC-123 DEF-456 related work")).toEqual(["ABC-123", "DEF-456"]);
  });

  test("extracts from branch name format", () => {
    expect(extractIssueKeys("feature/ABC-123-new-auth")).toEqual(["ABC-123"]);
  });

  test("returns empty array when no keys", () => {
    expect(extractIssueKeys("just a regular commit")).toEqual([]);
  });

  test("handles numeric project prefix", () => {
    expect(extractIssueKeys("X2-42 fix")).toEqual(["X2-42"]);
  });

  test("deduplicates keys", () => {
    expect(extractIssueKeys("ABC-123 more about ABC-123")).toEqual(["ABC-123"]);
  });

  test("extracts INT tickets", () => {
    expect(extractIssueKeys("INT-7 Admin Work")).toEqual(["INT-7"]);
  });

  test("handles multiple INT tickets", () => {
    expect(extractIssueKeys("INT-17 and INT-2 meetings")).toEqual(["INT-17", "INT-2"]);
  });

  test("extracts from conventional commit format", () => {
    expect(extractIssueKeys("feat(PROJ-42): add auth flow")).toEqual(["PROJ-42"]);
  });

  test("handles empty string", () => {
    expect(extractIssueKeys("")).toEqual([]);
  });

  test("does not match lowercase keys", () => {
    expect(extractIssueKeys("abc-123 fix")).toEqual([]);
  });

  test("extracts from mixed branch and commit", () => {
    expect(extractIssueKeys("bugfix/GDI-17-airflow refs ADA-5")).toEqual(["GDI-17", "ADA-5"]);
  });
});
