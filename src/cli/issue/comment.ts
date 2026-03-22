import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig } from "../../lib/config.ts";
import { getIssue, searchUsers, addComment } from "../../lib/jira.ts";
import { adfToMarkdown } from "../../lib/adf.ts";
import { getActiveFile, writeSnapshot, appendComment } from "../../lib/snapshot.ts";
import { issueToMarkdown } from "../../lib/format.ts";
import type { AdfDoc, AdfNode, JiraUser } from "../../lib/types.ts";

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function buildCommentAdf(text: string, mentions: Map<string, JiraUser>): AdfDoc {
  const parts = text.split(/(@@\w+)/);
  const nodes: AdfNode[] = [];

  for (const part of parts) {
    if (part.startsWith("@@")) {
      const token = part.slice(2).toLowerCase();
      const user = mentions.get(token);
      if (user) {
        nodes.push({
          type: "mention",
          attrs: { id: user.accountId, text: user.displayName },
        });
      } else {
        nodes.push({ type: "text", text: part });
      }
    } else if (part) {
      // Handle hard line breaks within a segment
      const lines = part.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i]) {
          nodes.push({ type: "text", text: lines[i]! });
        }
        if (i < lines.length - 1) {
          nodes.push({ type: "hardBreak" });
        }
      }
    }
  }

  return {
    version: 1,
    type: "doc",
    content: [{ type: "paragraph", content: nodes }],
  };
}

export async function commentOnIssue(key: string): Promise<void> {
  const config = loadConfig();

  const spinner = p.spinner();
  spinner.start(`Fetching ${key}…`);

  let issue;
  try {
    issue = await getIssue(config, key, true);
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }
  spinner.stop(`Fetched ${key}`);

  // Print existing comments to stdout
  const comments = issue.fields.comment?.comments ?? [];
  if (comments.length > 0) {
    console.log("");
    for (const c of comments) {
      console.log(`  ${pc.bold(c.author.displayName)} — ${formatDate(c.created)}`);
      const body = adfToMarkdown(c.body);
      for (const line of body.split("\n")) {
        console.log(`  ${line}`);
      }
      console.log("");
    }
  } else {
    console.log("");
    console.log(pc.dim("  No comments yet."));
    console.log("");
  }

  // Ask whether to add a comment or just go back
  const action = await p.select({
    message: `Comments on ${pc.bold(key)}:`,
    options: [
      { value: "add",  label: "Add a comment" },
      { value: "done", label: "Done" },
    ],
  });
  if (p.isCancel(action) || action === "done") return;

  // Prompt for comment text
  const raw = await p.text({
    message: "Your comment:",
    placeholder: "Use @@name to mention someone",
    validate: (v) => (v?.trim() ? undefined : "Comment cannot be empty"),
  });
  if (p.isCancel(raw)) { p.cancel("Cancelled."); return; }
  const text = (raw as string).trim();

  // Resolve @@mentions
  const tokens = [...new Set((text.match(/@@(\w+)/g) ?? []).map((t) => t.slice(2)))];
  const mentions = new Map<string, JiraUser>();

  for (const token of tokens) {
    let users: JiraUser[];
    try {
      users = await searchUsers(config, token);
    } catch {
      users = [];
    }
    if (users.length === 0) {
      p.log.warn(`No users found for "@@${token}" — will be left as plain text.`);
      continue;
    }

    const picked = await p.select<string>({
      message: `Who is @@${token}?`,
      options: users.map((u) => ({
        value: u.accountId,
        label: u.displayName,
        hint: u.emailAddress,
      })),
    });
    if (p.isCancel(picked)) { p.cancel("Cancelled."); return; }

    const user = users.find((u) => u.accountId === picked)!;
    mentions.set(token.toLowerCase(), user);
  }

  // Confirm
  const confirmed = await p.confirm({
    message: `Post comment to ${pc.bold(key)}?`,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled.");
    return;
  }

  spinner.start("Posting comment…");

  try {
    const adf = buildCommentAdf(text, mentions);
    await addComment(config, key, adf);
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }
  spinner.stop(pc.green("✓ Comment posted"));

  // Update local file + snapshot with the new comment
  const activeFile = getActiveFile(key);
  if (activeFile) {
    const today = new Date().toISOString().slice(0, 10);
    // Build display name (replace mentions with display names)
    const displayText = text.replace(/@@(\w+)/g, (_, t: string) => {
      const u = mentions.get(t.toLowerCase());
      return u ? `@${u.displayName}` : `@@${t}`;
    });
    appendComment(activeFile, config.accountId, today, displayText);

    // Also update snapshot
    try {
      const updated = await getIssue(config, key, false);
      const updatedMarkdown = issueToMarkdown(updated, {});
      writeSnapshot(key, updatedMarkdown);
    } catch {
      // best-effort snapshot update
    }
  }
}
