import { Command } from "commander";
import { describeIssue } from "./issue/describe.ts";
import { setStatus } from "./issue/status.ts";
import { pullIssue } from "./issue/pull.ts";
import { pushIssue } from "./issue/push.ts";
import { commentOnIssue } from "./issue/comment.ts";
import { showTempo } from "./tempo/show.ts";
import { logTempo } from "./tempo/log.ts";
import { runConfig } from "./config.ts";
import { configureProjectWorkdir } from "./project/workdir.ts";
import { projectPullIssues } from "./project/pull.ts";
import { exploreIssues } from "./explore.ts";

export function buildProgram(): Command {
  const program = new Command("jira")
    .description("JIRA & Tempo CLI")
    .version("0.1.0");

  // jira config [key] [value]
  program
    .command("config [key] [value]")
    .description("Configure JIRA credentials, or get/set individual keys")
    .action(async (key?: string, value?: string) => {
      await runConfig(key, value);
    });

  // jira issue <subcommand>
  const issue = program
    .command("issue")
    .description("Issue operations");

  issue
    .command("describe [key]")
    .description("Print issue summary in terminal")
    .action(async (key: string | undefined) => {
      if (!key) {
        console.error("Error: issue key required");
        process.exit(1);
      }
      await describeIssue(key.toUpperCase());
    });

  issue
    .command("set")
    .description("Set issue fields")
    .addCommand(
      new Command("status")
        .description("Transition issue status")
        .argument("<key>", "Issue key (e.g. ABC-123)")
        .argument("[status]", "Target status name")
        .action(async (key: string, status?: string) => {
          await setStatus(key.toUpperCase(), status);
        })
    );

  issue
    .command("pull <key> [file]")
    .description("Fetch issue and write as Markdown")
    .option("--comments", "Include comments section")
    .action(async (key: string, file: string | undefined, opts: { comments?: boolean }) => {
      await pullIssue(key.toUpperCase(), file, opts);
    });

  issue
    .command("push <key> [file]")
    .description("Push local Markdown changes back to JIRA")
    .action(async (key: string, file: string | undefined) => {
      await pushIssue(key.toUpperCase(), file);
    });

  issue
    .command("comment <key>")
    .description("Post a comment on an issue (supports @@mention)")
    .action(async (key: string) => {
      await commentOnIssue(key.toUpperCase());
    });

  // jira project <subcommand>
  const project = program
    .command("project")
    .description("Project configuration");

  project
    .command("workdir [key] [path]")
    .description("Set per-project working directory")
    .action(async (key?: string, path?: string) => {
      await configureProjectWorkdir(key?.toUpperCase(), path);
    });

  project
    .command("pull [project] [scope]")
    .description("Bulk pull issues into working directory (scope: sprint|backlog|all)")
    .option("--from <date>", "Only issues updated on or after this date (YYYY-MM-DD)")
    .option("--status <statuses>", "Comma-separated status names to filter by")
    .action(async (projectKey?: string, scope?: string, opts: { from?: string; status?: string } = {}) => {
      await projectPullIssues(projectKey, scope, opts);
    });

  // jira explore
  program
    .command("explore [project] [scope]")
    .description("Browse JIRA issues interactively (scope: sprint|backlog|all)")
    .option("--from <date>", "Only issues updated on or after this date (YYYY-MM-DD)")
    .option("--status <statuses>", "Comma-separated status names to filter by")
    .action(async (project?: string, scope?: string, opts: { from?: string; status?: string } = {}) => {
      await exploreIssues(project, scope, opts);
    });

  // jira tempo <subcommand>
  const tempo = program
    .command("tempo")
    .description("Tempo operations");

  tempo
    .command("show [from] [to]")
    .description("Show logged hours across a date range (from: YYYY-MM-DD, week, month)")
    .option("--file [path]", "Emit markdown to stdout or write to a file if path given")
    .action(async (from?: string, to?: string, opts: { file?: boolean } = {}) => {
      await showTempo(from, to, opts);
    });

  tempo
    .command("log [from] [to]")
    .description("Log hours across a date range (from: YYYY-MM-DD, week, month)")
    .option("--file <path>", "Read entries from a markdown file")
    .option("--skip-when <value>", "Skip days: '8h' (fully logged) or 'any' (has any log)")
    .action(async (from?: string, to?: string, opts: { file?: string; skipWhen?: string } = {}) => {
      await logTempo(from, to, opts);
    });

  return program;
}
