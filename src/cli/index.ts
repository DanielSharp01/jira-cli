import { Command } from "commander";
import { describeIssue } from "./issue/describe.ts";
import { setStatus } from "./issue/status.ts";
import { pullIssue } from "./issue/pull.ts";
import { pushIssue } from "./issue/push.ts";
import { commentOnIssue } from "./issue/comment.ts";
import { showTempo } from "./tempo/show.ts";
import { logTempo } from "./tempo/log.ts";
import { suggestTempo } from "./tempo/suggest.ts";
import { tempoUI } from "./tempo/ui.ts";
import { runConfig, getConfig, setConfig } from "./config.ts";
import { configureProjectWorkdir } from "./project/workdir.ts";
import { projectPullIssues } from "./project/pull.ts";
import { exploreIssues } from "./explore.ts";

export function buildProgram(): Command {
  const program = new Command("jira")
    .description("JIRA & Tempo CLI")
    .version("0.1.0");

  // jira config
  const config = program.command("config").description("Manage JIRA configuration");

  config
    .command("setup")
    .description("Run interactive setup wizard")
    .action(async () => { await runConfig(); });

  config
    .command("get [key]")
    .description([
      "Show all config values, or a single key",
      "Keys:",
      "  baseUrl",
      "  authType",
      "  email",
      "  jiraPat",
      "  tempoPat",
      "  scanDirs",
      "  google",
      "    clientId  clientSecret",
      "  tableWidths",
      "    key  type  status  sprint  estimate  summary",
      "  accountId  (read-only)",
    ].join("\n"))
    .action(async (key?: string) => { await getConfig(key); });

  config
    .command("set [key] [value]")
    .description([
      "Interactively set a config value, or pass key and value directly",
      "Keys:",
      "  baseUrl",
      "  authType",
      "  email",
      "  jiraPat",
      "  tempoPat",
      "  scanDirs",
      "  google",
      "    clientId  clientSecret",
      "  tableWidths",
      "    key  type  status  sprint  estimate  summary",
    ].join("\n"))
    .action(async (key?: string, value?: string) => { await setConfig(key, value); });

  // jira issue <subcommand>
  const issue = program.command("issue").description("Issue operations");

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
        }),
    );

  issue
    .command("pull <key> [file]")
    .description("Fetch issue and write as Markdown")
    .option("--comments", "Include comments section")
    .action(
      async (
        key: string,
        file: string | undefined,
        opts: { comments?: boolean },
      ) => {
        await pullIssue(key.toUpperCase(), file, opts);
      },
    );

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
    .description('Bulk pull issues into working directory (scope: sprint|current-sprint|backlog|all|"Sprint Name")')
    .option("--from <date>", "Updated on or after (YYYY-MM-DD or date expression)")
    .option("--to <date>", "Updated on or before (YYYY-MM-DD or date expression)")
    .option("--fromKey <number>", "Minimum issue number", parseInt)
    .option("--toKey <number>", "Maximum issue number", parseInt)
    .option("--status <values>", "Comma-separated statuses; prefix with not: to exclude")
    .option("--type <values>", "Comma-separated issue types; prefix with not: to exclude")
    .option("--estimated <mode>", "Estimate filter: all|yes|no|parent (default: all)")
    .option("--name <query>", "Search summary (Google-style: foo \"exact phrase\")")
    .option("--description <query>", "Search description (Google-style)")
    .option("--pick", "Interactively select which issues to pull")
    .action(
      async (
        projectKey?: string,
        scope?: string,
        opts: { from?: string; to?: string; fromKey?: number; toKey?: number; status?: string; type?: string; estimated?: string; name?: string; description?: string; pick?: boolean } = {},
      ) => {
        await projectPullIssues(projectKey, scope, opts);
      },
    );

  // jira explore
  program
    .command("explore [project] [scope]")
    .description('Browse JIRA issues interactively (scope: sprint|current-sprint|backlog|all|"Sprint Name")')
    .option("--from <date>", "Updated on or after (YYYY-MM-DD or date expression)")
    .option("--to <date>", "Updated on or before (YYYY-MM-DD or date expression)")
    .option("--fromKey <number>", "Minimum issue number", parseInt)
    .option("--toKey <number>", "Maximum issue number", parseInt)
    .option("--status <values>", "Comma-separated statuses; prefix with not: to exclude")
    .option("--type <values>", "Comma-separated issue types; prefix with not: to exclude")
    .option("--estimated <mode>", "Estimate filter: all|yes|no|parent (default: all)")
    .option("--name <query>", "Search summary (Google-style: foo \"exact phrase\")")
    .option("--description <query>", "Search description (Google-style)")
    .option("--no-interactive", "Print results to stdout without launching the TUI")
    .action(
      async (
        project?: string,
        scope?: string,
        opts: { from?: string; to?: string; fromKey?: number; toKey?: number; status?: string; type?: string; estimated?: string; name?: string; description?: string; interactive?: boolean } = {},
      ) => {
        await exploreIssues(project, scope, opts);
      },
    );

  // jira tempo <subcommand>
  const tempo = program.command("tempo").description("Tempo operations");

  tempo
    .command("show [from] [to]")
    .description(
      "Show logged hours. [from] syntax (inclusive on both sides): today, yesterday, year, month, week, YYYY-MM-DD, [-]N-unit, last/next-unit, or append -end for period end (e.g. month-end, week-end). [to] uses the same syntax.",
    )
    .option("--file <path>", "Write markdown to a file")
    .option("--stdout", "Print markdown to stdout")
    .option(
      "--days <filter>",
      "Day filter: all|working|unlogged|no-logs (default: unlogged)",
    )
    .option("--logged <duration>", "Fully-logged threshold (default: 8h)")
    .option("--short", "Compact view: one line per day showing logged/target")
    .action(
      async (
        from?: string,
        to?: string,
        opts: {
          file?: string;
          stdout?: boolean;
          days?: string;
          logged?: string;
          short?: boolean;
        } = {},
      ) => {
        await showTempo(from, to, opts);
      },
    );

  tempo
    .command("log [from] [to]")
    .description("Log hours interactively or from a file/stdin")
    .option("--file <path>", "Read entries from a markdown file")
    .option("--stdin", "Read entries from stdin")
    .option(
      "--days <filter>",
      "Day filter: all|working|unlogged|no-logs (default: unlogged)",
    )
    .option("--logged <duration>", "Fully-logged threshold (default: 8h)")
    .option("--exact", "File days must exactly match the filtered working days")
    .option("--prompt", "Prompt interactively for days missing from file")
    .action(
      async (
        from?: string,
        to?: string,
        opts: {
          file?: string;
          stdin?: boolean;
          days?: string;
          logged?: string;
          exact?: boolean;
          prompt?: boolean;
        } = {},
      ) => {
        await logTempo(from, to, opts);
      },
    );

  tempo
    .command("suggest [from] [to]")
    .description("AI-powered worklog suggestions from git activity, JIRA transitions, and historical patterns")
    .option("--repo <paths...>", "Additional git repos to scan")
    .option("--no-git", "Skip git scanning")
    .option("--hours <duration>", "Target hours per day (default: 8h)")
    .option("--model <name>", "Override LLM model (default: gpt-5.4-mini)")
    .option("--dry-run", "Show suggestions without submitting")
    .action(
      async (
        from?: string,
        to?: string,
        opts: {
          repo?: string[];
          noGit?: boolean;
          hours?: string;
          model?: string;
          dryRun?: boolean;
        } = {},
      ) => {
        await suggestTempo(from, to, opts);
      },
    );

  tempo
    .command("ui [from] [to]")
    .description("Open a Tempo-like timesheet UI in the browser")
    .option("--port <number>", "Server port (default: random)", parseInt)
    .option("--repo <paths...>", "Additional git repos to scan for suggestions")
    .option("--hours <duration>", "Target hours per day (default: 8h)")
    .option("--no-open", "Don't open browser automatically")
    .action(
      async (
        from?: string,
        to?: string,
        opts: {
          port?: number;
          repo?: string[];
          hours?: string;
          open?: boolean;
        } = {},
      ) => {
        await tempoUI(from, to, opts);
      },
    );

  return program;
}
