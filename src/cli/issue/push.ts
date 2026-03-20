import * as p from "@clack/prompts";
import pc from "picocolors";
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { loadConfig } from "../../lib/config.ts";
import { getIssue, getTransitions, applyTransition, updateIssue, searchUsers } from "../../lib/jira.ts";
import { parseIssueFile, issueToMarkdown } from "../../lib/format.ts";
import { markdownToAdf } from "../../lib/adf.ts";
import {
  readSnapshot,
  writeSnapshot,
  getActiveFile,
  moveIssueFile,
} from "../../lib/snapshot.ts";
import { resolveIssuePath } from "../../lib/projects.ts";
import type { ParsedIssueFile } from "../../lib/types.ts";

type FieldDecision = "noop" | "push" | "conflict";

function decide(
  local: string | undefined,
  base: string | undefined,
  remote: string | undefined
): FieldDecision {
  const l = (local ?? "").trim();
  const b = (base ?? "").trim();
  const r = (remote ?? "").trim();
  if (l === r) return "noop";
  if (!base || b === r) return "push"; // base missing or base == remote → user changed
  if (l === b) return "noop";          // remote changed but user didn't → remote wins
  return "conflict";                   // both changed
}

const EDITABLE_FIELDS = ["summary", "status", "assignee", "priority", "estimate", "description"] as const;
type EditableField = typeof EDITABLE_FIELDS[number];

function getField(parsed: ParsedIssueFile, field: EditableField): string | undefined {
  if (field === "summary") return parsed.summary;
  if (field === "description") return parsed.description;
  return parsed.fields[field as keyof typeof parsed.fields];
}

export async function pushIssue(
  key: string,
  filePath: string | undefined
): Promise<void> {
  const config = loadConfig();

  // Resolve input file: explicit arg → active file → default path
  const inPath = filePath
    ? resolve(filePath)
    : (getActiveFile(key) ?? join(process.cwd(), `${key}.md`));

  if (!existsSync(inPath)) {
    p.log.error(`File not found: ${inPath}`);
    process.exit(1);
  }

  let local: ParsedIssueFile;
  try {
    local = parseIssueFile(readFileSync(inPath, "utf-8"));
  } catch (err) {
    p.log.error(`Failed to parse file: ${String(err)}`);
    process.exit(1);
  }

  if (local.key !== key) {
    p.log.warn(`File key (${local.key}) does not match argument (${key}). Using argument key.`);
  }

  const base = readSnapshot(key);

  const spinner = p.spinner();
  spinner.start(`Fetching remote state for ${key}…`);

  let remote: ParsedIssueFile;
  try {
    const remoteIssue = await getIssue(config, key, false);
    remote = parseIssueFile(issueToMarkdown(remoteIssue, {}));
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }
  spinner.stop(`Fetched ${key}`);

  if (!base) {
    p.log.warn("No local snapshot found — skipping conflict check, pushing all fields.");
  }

  // Resolve per-field decisions
  const toPush: Partial<Record<EditableField, string>> = {};

  for (const field of EDITABLE_FIELDS) {
    const localVal = getField(local, field);
    const baseVal = base ? getField(base, field) : undefined;
    const remoteVal = getField(remote, field);

    const decision = decide(localVal, baseVal, remoteVal);

    if (decision === "noop") continue;

    if (decision === "conflict") {
      const keep = await p.confirm({
        message:
          `Conflict on ${pc.bold(field)}:\n` +
          `  Remote: ${pc.dim(remoteVal ?? "(empty)")}\n` +
          `  Local:  ${pc.cyan(localVal ?? "(empty)")}\n` +
          `Keep local?`,
        initialValue: false,
      });
      if (p.isCancel(keep)) { p.cancel("Cancelled."); process.exit(0); }
      if (!keep) continue; // keep remote → skip this field
    }

    // decision === "push" or user chose to keep local after conflict
    toPush[field] = localVal;
  }

  if (Object.keys(toPush).length === 0) {
    p.log.info("No changes to push.");
    return;
  }

  const fieldList = Object.keys(toPush).join(", ");
  const confirmed = await p.confirm({
    message: `Push ${pc.bold(fieldList)} to ${pc.bold(key)}?`,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  spinner.start(`Pushing ${key}…`);

  try {
    const fields: Record<string, unknown> = {};

    if ("summary" in toPush) {
      fields["summary"] = toPush.summary;
    }
    if ("description" in toPush) {
      fields["description"] = markdownToAdf(toPush.description ?? "");
    }
    if ("priority" in toPush && toPush.priority) {
      fields["priority"] = { name: toPush.priority };
    }
    if ("estimate" in toPush && toPush.estimate) {
      fields["timetracking"] = { originalEstimate: toPush.estimate };
    }
    if ("assignee" in toPush) {
      if (toPush.assignee) {
        const users = await searchUsers(config, toPush.assignee);
        const match = users.find(
          (u) => u.emailAddress?.toLowerCase() === toPush.assignee?.toLowerCase()
        );
        if (match) {
          fields["assignee"] = { accountId: match.accountId };
        } else {
          spinner.stop("");
          p.log.warn(`Could not find user with email "${toPush.assignee}" — assignee not updated.`);
          spinner.start("Continuing…");
        }
      } else {
        fields["assignee"] = null; // unassign
      }
    }

    if (Object.keys(fields).length > 0) {
      await updateIssue(config, key, fields);
    }

    // Status transition
    let appliedTransition: { name: string; to?: { statusCategory?: { key: string } } } | undefined;
    if ("status" in toPush && toPush.status) {
      const transitions = await getTransitions(config, key);
      const match = transitions.find(
        (t) => t.name.toLowerCase() === toPush.status!.toLowerCase()
      );
      if (match) {
        await applyTransition(config, key, match.id);
        appliedTransition = match;
      } else {
        spinner.stop("");
        p.log.warn(
          `No transition named "${toPush.status}". Available: ${transitions.map((t) => t.name).join(", ")}`
        );
        spinner.start("Continuing…");
      }
    }

    // Re-fetch and write updated snapshot
    const updated = await getIssue(config, key, false);
    const updatedMarkdown = issueToMarkdown(updated, {});
    writeSnapshot(key, updatedMarkdown);

    spinner.stop(pc.green(`✓ Pushed ${key}`));

    // Move file if status category changed
    if (appliedTransition) {
      const newStatusCategoryKey =
        appliedTransition.to?.statusCategory?.key ??
        updated.fields.status.statusCategory?.key ?? "";
      const newPath = resolveIssuePath(key, newStatusCategoryKey);
      moveIssueFile(key, newPath);
    }
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }
}
