import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig, configExists } from "../lib/config.ts";
import { describeIssue } from "../cli/issue/describe.ts";
import { setStatus } from "../cli/issue/status.ts";
import { pullIssue } from "../cli/issue/pull.ts";
import { pushIssue } from "../cli/issue/push.ts";
import { commentOnIssue } from "../cli/issue/comment.ts";
import { showTempo } from "../cli/tempo/show.ts";
import { logTempo } from "../cli/tempo/log.ts";
import { runConfig } from "../cli/config.ts";
import { configureProjectWorkdir } from "../cli/project/workdir.ts";
import { exploreIssues } from "../cli/explore.ts";

export async function runTui(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" jira ")));

  if (!configExists()) {
    p.note("No config found. Let's set it up first.", "Setup");
    await runConfig();
    return;
  }

  // Validate config loads cleanly
  try {
    loadConfig();
  } catch (err) {
    p.log.error(String(err));
    process.exit(1);
  }

  const action = await p.select({
    message: "What do you want to do?",
    options: [
      { value: "explore", label: "Explore issues" },
      { value: "describe", label: "Describe issue" },
      { value: "pull", label: "Pull issue → Markdown" },
      { value: "push", label: "Push Markdown → JIRA" },
      { value: "comment", label: "Comment on issue" },
      { value: "status", label: "Set issue status" },
      { value: "show", label: "Show tempo logs" },
      { value: "worklog", label: "Log time (Tempo)" },
      { value: "project", label: "Configure project working directory" },
      { value: "config", label: "Configure" },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel("Bye.");
    return;
  }

  switch (action) {
    case "explore": {
      await exploreIssues(undefined, undefined, {});
      break;
    }

    case "describe": {
      const key = await p.text({ message: "Issue key", placeholder: "ABC-123" });
      if (p.isCancel(key)) { p.cancel("Cancelled."); return; }
      await describeIssue((key as string).toUpperCase());
      break;
    }

    case "pull": {
      const key = await p.text({ message: "Issue key", placeholder: "ABC-123" });
      if (p.isCancel(key)) { p.cancel("Cancelled."); return; }
      const file = await p.text({
        message: "Output file (leave blank for default)",
        placeholder: `${key}.md`,
        initialValue: "",
      });
      if (p.isCancel(file)) { p.cancel("Cancelled."); return; }
      const comments = await p.confirm({ message: "Include comments?", initialValue: false });
      if (p.isCancel(comments)) { p.cancel("Cancelled."); return; }
      await pullIssue((key as string).toUpperCase(), (file as string) || undefined, { comments: comments as boolean });
      break;
    }

    case "push": {
      const key = await p.text({ message: "Issue key", placeholder: "ABC-123" });
      if (p.isCancel(key)) { p.cancel("Cancelled."); return; }
      const file = await p.text({
        message: "File path (leave blank for default)",
        placeholder: `${key}.md`,
        initialValue: "",
      });
      if (p.isCancel(file)) { p.cancel("Cancelled."); return; }
      await pushIssue((key as string).toUpperCase(), (file as string) || undefined);
      break;
    }

    case "comment": {
      const key = await p.text({ message: "Issue key", placeholder: "ABC-123" });
      if (p.isCancel(key)) { p.cancel("Cancelled."); return; }
      await commentOnIssue((key as string).toUpperCase());
      break;
    }

    case "status": {
      const key = await p.text({ message: "Issue key", placeholder: "ABC-123" });
      if (p.isCancel(key)) { p.cancel("Cancelled."); return; }
      await setStatus((key as string).toUpperCase());
      break;
    }

    case "show": {
      await showTempo(undefined, undefined, {});
      break;
    }

    case "worklog": {
      await logTempo(undefined, undefined, {});
      break;
    }

    case "project":
      await configureProjectWorkdir();
      break;

    case "config":
      await runConfig();
      break;
  }

  p.outro(pc.green("Done."));
}
