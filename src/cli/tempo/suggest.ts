import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig } from "../../lib/config.ts";
import { parseDateRange } from "../../lib/date-range.ts";
import { parseDuration, formatDuration } from "../../lib/duration.ts";
import { discoverGitRepos, gatherAllEvidence } from "../../lib/signals.ts";
import { generateSuggestions } from "../../lib/suggest.ts";
import { getIssueIdsByKeys } from "../../lib/jira.ts";
import { createWorklog, deleteWorklog, getWorklogsForRange } from "../../lib/tempo.ts";
import type { SuggestResponse, DaySuggestions } from "../../lib/suggest-schemas.ts";
import type { WorklogEntry } from "../../lib/types.ts";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function dayLabel(dateStr: string): string {
  return DAYS[new Date(`${dateStr}T12:00:00`).getDay()]!;
}

function confIcon(confidence: string): string {
  if (confidence === "high") return pc.green("●");
  if (confidence === "medium") return pc.yellow("●");
  return pc.dim("○");
}

// ---------------------------------------------------------------------------
// Display suggestions
// ---------------------------------------------------------------------------

function displaySuggestions(
  suggestions: SuggestResponse,
  existingByDate: Map<string, Array<{ issueKey: string; seconds: number; description: string }>>,
): void {
  for (const day of suggestions.days) {
    console.log();
    const totalDur = formatDuration(
      day.entries.reduce((s, e) => s + parseDuration(e.durationHuman), 0)
    );
    console.log(`  ${pc.bold(day.date)} (${dayLabel(day.date)}) ${pc.dim("—")} ${pc.green(totalDur)} suggested`);

    const existing = existingByDate.get(day.date) ?? [];
    if (existing.length > 0) {
      const existingTotal = existing.reduce((s, w) => s + w.seconds, 0);
      console.log(pc.dim(`    Already logged: ${formatDuration(existingTotal)}`));
    }

    for (const entry of day.entries) {
      console.log(
        `    ${confIcon(entry.confidence)} ${pc.cyan(entry.issueKey.padEnd(12))} ${entry.durationHuman.padEnd(6)} ${entry.description}`
      );
      console.log(pc.dim(`      ${entry.reasoning}`));
    }
  }
}

// ---------------------------------------------------------------------------
// Export to markdown
// ---------------------------------------------------------------------------

function suggestionsToMarkdown(suggestions: SuggestResponse): string {
  const lines: string[] = [];
  for (const day of suggestions.days) {
    lines.push(`# ${day.date} (${dayLabel(day.date)})`);
    for (const entry of day.entries) {
      lines.push(`- ${entry.issueKey} ${entry.description} ${entry.durationHuman}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

interface SubmitPlan {
  date: string;
  entries: WorklogEntry[];
  action: "replace" | "append";
}

async function submitPlans(
  config: ReturnType<typeof loadConfig>,
  plans: SubmitPlan[],
  existingWorklogs: Awaited<ReturnType<typeof getWorklogsForRange>>,
): Promise<void> {
  // Resolve issue keys → IDs
  const allKeys = [...new Set(plans.flatMap(p => p.entries.map(e => e.issueKey)))];
  const issueIds = await getIssueIdsByKeys(config, allKeys);

  const unresolved = allKeys.filter(k => !issueIds.get(k));
  if (unresolved.length > 0) {
    p.log.error(`Could not resolve Jira IDs for: ${unresolved.join(", ")}`);
    process.exit(1);
  }

  const spinner = p.spinner();
  spinner.start("Submitting to Tempo...");

  try {
    for (const plan of plans) {
      // Delete existing if replacing
      if (plan.action === "replace") {
        const existing = existingWorklogs.filter(w => w.startDate === plan.date);
        for (const wl of existing) {
          await deleteWorklog(config, wl.tempoWorklogId);
        }
      }

      // Calculate start time cursor
      let cursorSeconds = 9 * 3600; // 09:00
      if (plan.action === "append") {
        const dayWorklogs = existingWorklogs.filter(w => w.startDate === plan.date);
        if (dayWorklogs.length > 0) {
          const lastEnd = Math.max(...dayWorklogs.map(w => {
            const [hh, mm, ss] = w.startTime.split(":").map(Number);
            return hh! * 3600 + mm! * 60 + ss! + w.timeSpentSeconds;
          }));
          cursorSeconds = lastEnd;
        }
      }

      // Create worklogs
      for (const entry of plan.entries) {
        const issueId = issueIds.get(entry.issueKey)!;
        const hh = String(Math.floor(cursorSeconds / 3600)).padStart(2, "0");
        const mm = String(Math.floor((cursorSeconds % 3600) / 60)).padStart(2, "0");
        const ss = String(cursorSeconds % 60).padStart(2, "0");
        await createWorklog(config, {
          issueId,
          timeSpentSeconds: entry.durationSeconds,
          startDate: plan.date,
          startTime: `${hh}:${mm}:${ss}`,
          description: entry.description,
        });
        cursorSeconds += entry.durationSeconds;
      }
    }
    spinner.stop(pc.green("Done!"));
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(String(err));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Convert suggestions to submit plans
// ---------------------------------------------------------------------------

function suggestionsToPlans(
  days: DaySuggestions[],
  existingByDate: Map<string, Array<{ issueKey: string; seconds: number; description: string }>>,
): SubmitPlan[] {
  return days.map(day => ({
    date: day.date,
    entries: day.entries.map(e => ({
      issueKey: e.issueKey,
      durationSeconds: parseDuration(e.durationHuman),
      description: e.description,
    })),
    action: (existingByDate.get(day.date) ?? []).length > 0 ? "replace" as const : "append" as const,
  }));
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function suggestTempo(
  fromArg?: string,
  toArg?: string,
  opts: {
    repo?: string[];
    noGit?: boolean;
    hours?: string;
    model?: string;
    dryRun?: boolean;
  } = {}
): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch {
    p.log.error("No config found. Run `jira config setup` first.");
    process.exit(1);
  }

  // Parse date range
  let range: { from: string; to: string };
  try {
    range = parseDateRange(fromArg, toArg);
  } catch (err) {
    p.log.error(String(err));
    process.exit(1);
  }

  // Parse target hours
  let targetSeconds: number;
  try {
    targetSeconds = parseDuration(opts.hours ?? "8h");
  } catch {
    p.log.error(`Invalid --hours value "${opts.hours}"`);
    process.exit(1);
  }
  const targetHours = targetSeconds / 3600;

  // Discover git repos
  let repoPaths: string[] = [];
  if (!opts.noGit) {
    const spinner = p.spinner();
    spinner.start("Discovering git repositories...");
    try {
      const enabledDirs = (config.scanDirs ?? []).filter(d => d.enabled).map(d => d.path);
      repoPaths = await discoverGitRepos(opts.repo ?? [], enabledDirs);
      spinner.stop(`Found ${repoPaths.length} git repo(s)`);
    } catch (err) {
      spinner.stop("Git discovery failed");
      p.log.warn(`Could not discover git repos: ${String(err)}`);
    }
  }

  // Gather evidence
  const evidenceSpinner = p.spinner();
  evidenceSpinner.start(`Gathering evidence for ${range.from} → ${range.to}...`);

  let evidence;
  try {
    evidence = await gatherAllEvidence(config, repoPaths, range.from, range.to);
  } catch (err) {
    evidenceSpinner.stop("Failed");
    p.log.error(`Evidence gathering failed: ${String(err)}`);
    process.exit(1);
  }

  const commitCount = evidence.git.reduce((n, r) => n + r.commits.length, 0);
  const transitionCount = evidence.jiraActivity.statusTransitions.length;
  const patternCount = evidence.historicalPatterns.recurringPatterns.length;
  evidenceSpinner.stop(
    `${commitCount} commits, ${transitionCount} status transitions, ${patternCount} recurring patterns`
  );

  // Filter to days needing logs
  const daysNeedingLogs = evidence.workingDays.filter(date => {
    const existing = evidence.existingWorklogs.get(date) ?? [];
    const totalSeconds = existing.reduce((s, w) => s + w.seconds, 0);
    return totalSeconds < targetSeconds;
  });

  if (daysNeedingLogs.length === 0) {
    p.log.success("All working days in this range are fully logged!");
    return;
  }

  console.log(pc.dim(`  ${daysNeedingLogs.length} of ${evidence.workingDays.length} working day(s) need logs`));

  // Check for minimal evidence
  const hasAnyEvidence = commitCount > 0 || transitionCount > 0 || patternCount > 0
    || evidence.jiraActivity.sprintIssues.length > 0;

  if (!hasAnyEvidence) {
    p.log.warn("No evidence found (no git activity, no Jira transitions, no historical patterns).");
    const proceed = await p.confirm({ message: "Generate suggestions anyway?" });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel("Cancelled.");
      return;
    }
  }

  // Generate suggestions via LLM
  const llmSpinner = p.spinner();
  llmSpinner.start("Generating suggestions...");

  let suggestions: SuggestResponse;
  try {
    suggestions = await generateSuggestions(evidence, targetHours, opts.model);
  } catch (err) {
    llmSpinner.stop("Failed");
    p.log.error(`Suggestion generation failed: ${String(err)}`);
    process.exit(1);
  }

  llmSpinner.stop(`Generated suggestions for ${suggestions.days.length} day(s)`);

  if (suggestions.days.length === 0) {
    p.log.warn("No suggestions generated.");
    return;
  }

  // Display suggestions
  displaySuggestions(suggestions, evidence.existingWorklogs);

  // Dry run mode — just show and exit
  if (opts.dryRun) {
    console.log(pc.dim("\n  --dry-run: no entries submitted."));
    return;
  }

  // Interactive review
  console.log();
  const totalEntries = suggestions.days.reduce((n, d) => n + d.entries.length, 0);
  const action = await p.select({
    message: `${totalEntries} entries across ${suggestions.days.length} day(s) — what to do?`,
    options: [
      { value: "accept", label: "Accept all — submit to Tempo" },
      { value: "review", label: "Review per day — accept/skip each day" },
      { value: "export", label: "Export — write markdown file for manual editing" },
      { value: "cancel", label: "Cancel" },
    ],
  });

  if (p.isCancel(action) || action === "cancel") {
    p.cancel("Cancelled.");
    return;
  }

  if (action === "export") {
    const md = suggestionsToMarkdown(suggestions);
    const filePath = `tempo-suggestions-${range.from}-to-${range.to}.md`;
    await Bun.write(filePath, md);
    p.log.success(`Exported to ${pc.cyan(filePath)}`);
    console.log(pc.dim(`  Edit the file, then run: jira tempo log --file ${filePath} ${range.from} ${range.to}`));
    return;
  }

  // Fetch raw worklogs for submission (need full TempoWorklog objects for delete)
  const existingWorklogsRaw = await getWorklogsForRange(config, range.from, range.to);

  if (action === "accept") {
    // Submit all
    const plans = suggestionsToPlans(suggestions.days, evidence.existingWorklogs);

    // Show summary
    console.log(`\n${pc.bold("Summary:")}`);
    for (const plan of plans) {
      const total = plan.entries.reduce((s, e) => s + e.durationSeconds, 0);
      console.log(`  ${pc.green("+")} ${plan.date} ${formatDuration(total)} (${plan.entries.length} entries) — ${plan.action}`);
    }

    const confirmed = await p.confirm({
      message: `Submit ${totalEntries} entries across ${plans.length} day(s)?`,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Cancelled.");
      return;
    }

    await submitPlans(config, plans, existingWorklogsRaw);

    const totalLogged = plans.reduce((s, p) => s + p.entries.reduce((s2, e) => s2 + e.durationSeconds, 0), 0);
    console.log(`\n${pc.green("All logs submitted.")} Total: ${formatDuration(totalLogged)} across ${plans.length} day(s)`);
    return;
  }

  // Review per day
  const acceptedDays: DaySuggestions[] = [];
  for (const day of suggestions.days) {
    console.log();
    console.log(`  ${pc.bold(day.date)} (${dayLabel(day.date)})`);
    for (let i = 0; i < day.entries.length; i++) {
      const e = day.entries[i]!;
      console.log(`    ${i + 1}. ${confIcon(e.confidence)} ${pc.cyan(e.issueKey)} ${e.durationHuman} ${e.description}`);
    }

    const dayAction = await p.select({
      message: `${day.date}:`,
      options: [
        { value: "accept", label: "Accept this day" },
        { value: "skip", label: "Skip this day" },
      ],
    });

    if (p.isCancel(dayAction)) {
      p.cancel("Cancelled.");
      return;
    }

    if (dayAction === "accept") {
      acceptedDays.push(day);
    }
  }

  if (acceptedDays.length === 0) {
    console.log(pc.yellow("\nNo days accepted."));
    return;
  }

  const plans = suggestionsToPlans(acceptedDays, evidence.existingWorklogs);
  const acceptedEntries = plans.reduce((n, p) => n + p.entries.length, 0);

  const confirmed = await p.confirm({
    message: `Submit ${acceptedEntries} entries across ${acceptedDays.length} day(s)?`,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled.");
    return;
  }

  await submitPlans(config, plans, existingWorklogsRaw);

  const totalLogged = plans.reduce((s, p) => s + p.entries.reduce((s2, e) => s2 + e.durationSeconds, 0), 0);
  console.log(`\n${pc.green("All logs submitted.")} Total: ${formatDuration(totalLogged)} across ${acceptedDays.length} day(s)`);
}
