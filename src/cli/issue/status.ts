import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig } from "../../lib/config.ts";
import { getTransitions, applyTransition } from "../../lib/jira.ts";
import { getActiveFile, snapshotPath, updateFieldLine, moveIssueFile } from "../../lib/snapshot.ts";
import { resolveIssuePath } from "../../lib/projects.ts";

export async function setStatus(key: string, statusName?: string): Promise<void> {
  const config = loadConfig();

  const spinner = p.spinner();
  spinner.start(`Fetching transitions for ${key}…`);

  let transitions;
  try {
    transitions = await getTransitions(config, key);
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }
  spinner.stop(`Found ${transitions.length} transitions`);

  let transitionId: string;

  if (statusName) {
    const match = transitions.find(
      (t) => t.name.toLowerCase() === statusName.toLowerCase()
    );
    if (!match) {
      p.log.error(
        `No transition named "${statusName}". Available: ${transitions.map((t) => t.name).join(", ")}`
      );
      process.exit(1);
    }
    transitionId = match.id;
  } else {
    const selected = await p.select({
      message: `Transition ${pc.bold(key)} to:`,
      options: transitions.map((t) => ({ value: t.id, label: t.name })),
    });
    if (p.isCancel(selected)) {
      p.cancel("Cancelled.");
      return;
    }
    transitionId = selected as string;
  }

  const chosen = transitions.find((t) => t.id === transitionId)!;
  spinner.start(`Transitioning to "${chosen.name}"…`);
  try {
    await applyTransition(config, key, transitionId);
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }
  spinner.stop(pc.green(`✓ ${key} → ${chosen.name}`));

  // Patch the Status line in the active local file + snapshot
  const activeFile = getActiveFile(key);
  if (activeFile) {
    updateFieldLine(activeFile, "Status", chosen.name);
    updateFieldLine(snapshotPath(key), "Status", chosen.name);
  }

  // Move file if status subfolder config is active
  const newStatusCategoryKey = chosen.to?.statusCategory?.key ?? "";
  if (newStatusCategoryKey) {
    const newPath = resolveIssuePath(key, newStatusCategoryKey);
    moveIssueFile(key, newPath);
  }
}
