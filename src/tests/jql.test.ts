import { describe, test, expect } from "bun:test";
import { buildJql, parseSearchTokens } from "../lib/jql.ts";

describe("buildJql — scope", () => {
  test("default (all) produces just project clause", () => {
    const jql = buildJql("PROJ", {});
    expect(jql).toContain(`project = "PROJ"`);
    expect(jql).not.toContain("sprint");
  });

  test("scope=sprint uses openSprints()", () => {
    const jql = buildJql("PROJ", { scope: "sprint" });
    expect(jql).toContain("sprint in openSprints()");
  });

  test("scope=current-sprint uses openSprints()", () => {
    const jql = buildJql("PROJ", { scope: "current-sprint" });
    expect(jql).toContain("sprint in openSprints()");
  });

  test("scope=backlog adds sprint is EMPTY clause", () => {
    const jql = buildJql("PROJ", { scope: "backlog" });
    expect(jql).toContain("sprint is EMPTY");
    expect(jql).toContain("statusCategory != Done");
  });

  test("scope=all is the same as default", () => {
    const all = buildJql("PROJ", { scope: "all" });
    const def = buildJql("PROJ", {});
    expect(all).toBe(def);
  });

  test("named sprint adds sprint = clause", () => {
    const jql = buildJql("PROJ", { scope: "Sprint 42" });
    expect(jql).toContain(`sprint = "Sprint 42"`);
  });

  test("named sprint with double-quotes is escaped", () => {
    const jql = buildJql("PROJ", { scope: 'Sprint "X"' });
    expect(jql).toContain(`sprint = "Sprint \\"X\\""`);
  });
});

describe("buildJql — status filter", () => {
  test("plain values produce IN clause", () => {
    const jql = buildJql("PROJ", { status: ["To Do", "In Progress"] });
    expect(jql).toContain(`status IN ("To Do", "In Progress")`);
  });

  test("not: prefix produces NOT IN clause", () => {
    const jql = buildJql("PROJ", { status: ["not:Done"] });
    expect(jql).toContain(`status NOT IN ("Done")`);
    expect(jql).not.toContain("status IN");
  });

  test("not: prefix is case-insensitive", () => {
    const jql = buildJql("PROJ", { status: ["NOT:Done"] });
    expect(jql).toContain(`status NOT IN ("Done")`);
  });

  test("mixed positive and negated produce both clauses", () => {
    const jql = buildJql("PROJ", { status: ["In Progress", "not:Done"] });
    expect(jql).toContain(`status IN ("In Progress")`);
    expect(jql).toContain(`status NOT IN ("Done")`);
  });
});

describe("buildJql — type filter", () => {
  test("plain type produces IN clause", () => {
    const jql = buildJql("PROJ", { type: ["Story", "Bug"] });
    expect(jql).toContain(`issuetype IN ("Story", "Bug")`);
  });

  test("not: prefix produces NOT IN clause", () => {
    const jql = buildJql("PROJ", { type: ["not:Sub-task"] });
    expect(jql).toContain(`issuetype NOT IN ("Sub-task")`);
  });
});

describe("buildJql — date filters", () => {
  test("from adds updated >= clause", () => {
    const jql = buildJql("PROJ", { from: "2026-01-01" });
    expect(jql).toContain(`updated >= "2026-01-01"`);
  });

  test("to adds updated <= clause", () => {
    const jql = buildJql("PROJ", { to: "2026-03-31" });
    expect(jql).toContain(`updated <= "2026-03-31"`);
  });

  test("both from and to are included", () => {
    const jql = buildJql("PROJ", { from: "2026-01-01", to: "2026-03-31" });
    expect(jql).toContain(`updated >= "2026-01-01"`);
    expect(jql).toContain(`updated <= "2026-03-31"`);
  });
});

describe("buildJql — key range filters", () => {
  test("fromKey adds key >= clause with project prefix", () => {
    const jql = buildJql("PROJ", { fromKey: 100 });
    expect(jql).toContain(`key >= "PROJ-100"`);
  });

  test("toKey adds key <= clause with project prefix", () => {
    const jql = buildJql("PROJ", { toKey: 200 });
    expect(jql).toContain(`key <= "PROJ-200"`);
  });
});

describe("buildJql — estimated filter", () => {
  test("estimated=yes adds timeoriginalestimate is not EMPTY", () => {
    const jql = buildJql("PROJ", { estimated: "yes" });
    expect(jql).toContain(`"timeoriginalestimate" is not EMPTY`);
  });

  test("estimated=no adds timeoriginalestimate is EMPTY", () => {
    const jql = buildJql("PROJ", { estimated: "no" });
    expect(jql).toContain(`"timeoriginalestimate" is EMPTY`);
  });

  test("estimated=all adds no clause", () => {
    const jql = buildJql("PROJ", { estimated: "all" });
    expect(jql).not.toContain("timeoriginalestimate");
  });

  test("estimated=parent adds no clause (post-processed)", () => {
    const jql = buildJql("PROJ", { estimated: "parent" });
    expect(jql).not.toContain("timeoriginalestimate");
  });
});

describe("buildJql — text search", () => {
  test("name produces summary ~ clauses", () => {
    const jql = buildJql("PROJ", { name: "login bug" });
    expect(jql).toContain(`summary ~ "login"`);
    expect(jql).toContain(`summary ~ "bug"`);
  });

  test("name with quoted phrase keeps phrase together", () => {
    const jql = buildJql("PROJ", { name: 'foo "exact phrase"' });
    expect(jql).toContain(`summary ~ "foo"`);
    expect(jql).toContain(`summary ~ "exact phrase"`);
  });

  test("description produces description ~ clauses", () => {
    const jql = buildJql("PROJ", { description: "auth error" });
    expect(jql).toContain(`description ~ "auth"`);
    expect(jql).toContain(`description ~ "error"`);
  });
});

describe("parseSearchTokens", () => {
  test("splits bare words", () => {
    expect(parseSearchTokens("foo bar baz")).toEqual(["foo", "bar", "baz"]);
  });

  test("treats quoted string as single token", () => {
    expect(parseSearchTokens('"hello world"')).toEqual(["hello world"]);
  });

  test("mixes bare and quoted", () => {
    expect(parseSearchTokens('foo "bar baz" qux')).toEqual(["foo", "bar baz", "qux"]);
  });

  test("empty string returns empty array", () => {
    expect(parseSearchTokens("")).toEqual([]);
  });
});

describe("buildJql — always ends with ORDER BY updated DESC", () => {
  test("ends with ORDER BY updated DESC", () => {
    const jql = buildJql("PROJ", {});
    expect(jql).toMatch(/ORDER BY updated DESC$/);
  });
});
