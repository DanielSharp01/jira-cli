import * as p from "@clack/prompts";
import { runListPicker, sprintDateRange } from "../lib/tui.ts";
import { getBoards, getBoardSprints } from "../lib/jira.ts";
import type { JiraSprint } from "../lib/types.ts";
import type { loadConfig } from "../lib/config.ts";

// ---------------------------------------------------------------------------
// Scope / sprint picker
// ---------------------------------------------------------------------------

export async function pickScope(
  config: ReturnType<typeof loadConfig>,
  projectKey: string
): Promise<string | null> {
  const spinner = p.spinner();
  spinner.start("Loading sprints…");
  let boards: Awaited<ReturnType<typeof getBoards>> = [];
  try { boards = await getBoards(config, projectKey); } catch { /* ignore */ }
  const boardId = boards[0]?.id;

  let activeSprints: JiraSprint[] = [];
  if (boardId !== undefined) {
    try {
      const [active, future] = await Promise.all([
        getBoardSprints(config, boardId, "active"),
        getBoardSprints(config, boardId, "future"),
      ]);
      activeSprints = [...active, ...future];
    } catch { /* ignore */ }
  }
  spinner.stop("");

  const sprintLabel = (s: JiraSprint) => {
    const dates = sprintDateRange(s.startDate, s.endDate);
    return dates ? `${s.name}  ${dates}` : s.name;
  };

  let showDone = false;
  let doneSprints: JiraSprint[] = [];
  const DONE_SENTINEL = "__done__";

  while (true) {
    const items: Array<{ value: string; label: string; separator?: boolean }> = [
      { value: "sprint",  label: "Current sprint" },
      ...activeSprints.map((s) => ({ value: s.name, label: sprintLabel(s) })),
      { value: "backlog", label: "Backlog" },
      { value: "all",     label: "All issues" },
    ];
    if (showDone) {
      items.push({ value: "__done_sep__", label: "── Done sprints ──", separator: true });
      items.push(...doneSprints.map((s) => ({ value: s.name, label: sprintLabel(s) })));
    } else {
      items.push({ value: DONE_SENTINEL, label: "── Done sprints ──" });
    }

    const picked = await runListPicker("Scope / sprint:", items);
    if (picked === null) return null;
    if (picked === DONE_SENTINEL) {
      if (!showDone && boardId !== undefined) {
        const sp = p.spinner();
        sp.start("Loading completed sprints…");
        try { doneSprints = (await getBoardSprints(config, boardId, "closed")).reverse(); }
        catch { doneSprints = []; }
        sp.stop(`${doneSprints.length} completed sprint(s)`);
      }
      showDone = true;
      continue;
    }
    return picked;
  }
}

// ---------------------------------------------------------------------------
// Multi-value picker with include / exclude mode
// ---------------------------------------------------------------------------

export async function pickMultiWithMode(
  message: string,
  options: string[]
): Promise<string[] | null> {
  const mode = await p.select({
    message,
    options: [
      { value: "include",  label: "Include selected" },
      { value: "exclude",  label: "Exclude selected  (adds not: prefix)" },
      { value: "__back__", label: "← Back" },
    ],
  }) as string | symbol;
  if (p.isCancel(mode) || mode === "__back__") return null;

  const selected = await p.multiselect({
    message: mode === "include" ? "Select to include:" : "Select to exclude:",
    options: options.map((o) => ({ value: o, label: o })),
    required: true,
  });
  if (p.isCancel(selected)) return null;

  const values = selected as string[];
  return mode === "exclude" ? values.map((v) => `not:${v}`) : values;
}
