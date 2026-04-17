import { $ } from "bun";
import type { Config, TempoWorklog, JiraIssue } from "./types.ts";
import { searchIssues, getIssueChangelog, getIssueKeysByIds, getIssue } from "./jira.ts";
import { getWorklogsForRange, getWorkingDays } from "./tempo.ts";
import { loadProjects } from "./projects.ts";
import { resolve, dirname } from "node:path";
import { formatDuration } from "./duration.ts";
import { isGoogleConnected, getCalendarEvents, getChatActivity } from "./google.ts";
import type { CalendarEvent, ChatActivity } from "./google.ts";
import { adfToPlainText } from "./adf.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitCommit {
  hash: string;
  date: string;
  message: string;
  branch: string;
  repoPath: string;
  changedFiles?: string[];
  workType?: string; // "feature" | "bugfix" | "test" | "refactor" | "docs" | "chore"
}

export interface GitUncommitted {
  modifiedFiles: string[];
  stagedFiles: string[];
  linesAdded: number;
  linesRemoved: number;
}

export interface GitEvidence {
  repoPath: string;
  commits: GitCommit[];
  uncommitted: GitUncommitted | null;
}

export interface StatusTransition {
  issueKey: string;
  summary: string;
  fromStatus: string;
  toStatus: string;
  date: string;
}

export interface JiraEvidence {
  statusTransitions: StatusTransition[];
  sprintIssues: Array<{ issueKey: string; summary: string; status: string; type: string; estimate: string | null; descriptionSnippet: string | null }>;
  commentedIssues: Array<{ issueKey: string; summary: string; date: string }>;
}

export interface RecurringPattern {
  issueKey: string;
  description: string;
  avgDurationSeconds: number;
  occurrences: number;
  totalDays: number;
  cadence: "daily" | "weekly" | "occasional";
  dayOfWeekDistribution: Record<string, number>;
  primaryDays?: string[];
}

export interface HistoricalEvidence {
  recentWorklogs: Array<{ issueKey: string; description: string; durationSeconds: number; date: string }>;
  recurringPatterns: RecurringPattern[];
}

export interface GoogleEvidence {
  calendar: CalendarEvent[];
  chat: ChatActivity[];
}

export interface EvidenceBundle {
  dateRange: { from: string; to: string };
  workingDays: string[];
  existingWorklogs: Map<string, Array<{ issueKey: string; seconds: number; description: string }>>;
  git: GitEvidence[];
  jiraActivity: JiraEvidence;
  historicalPatterns: HistoricalEvidence;
  google?: GoogleEvidence;
}

// ---------------------------------------------------------------------------
// Issue key extraction
// ---------------------------------------------------------------------------

const ISSUE_KEY_RE = /[A-Z][A-Z0-9]+-\d+/g;

export function extractIssueKeys(text: string): string[] {
  const matches = text.match(ISSUE_KEY_RE);
  if (!matches) return [];
  return [...new Set(matches)];
}

// ---------------------------------------------------------------------------
// Git scanning
// ---------------------------------------------------------------------------

async function isGitRepo(path: string): Promise<boolean> {
  try {
    const result = await $`git -C ${path} rev-parse --is-inside-work-tree`.quiet();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function getGitRoot(path: string): Promise<string | null> {
  try {
    const result = await $`git -C ${path} rev-parse --show-toplevel`.quiet();
    return result.exitCode === 0 ? result.text().trim() : null;
  } catch {
    return null;
  }
}

async function getGitUserEmail(repoPath: string): Promise<string> {
  try {
    const result = await $`git -C ${repoPath} config user.email`.quiet();
    return result.text().trim();
  } catch {
    return "";
  }
}

async function scanRepo(repoPath: string, from: string, to: string): Promise<GitEvidence> {
  const email = await getGitUserEmail(repoPath);
  const commits: GitCommit[] = [];

  // Get commits in date range
  try {
    const afterDate = `${from}T00:00:00`;
    const beforeDate = new Date(new Date(`${to}T23:59:59`).getTime() + 86400000).toISOString().slice(0, 10);
    const logResult = await $`git -C ${repoPath} log --all ${email ? `--author=${email}` : ""} --after=${afterDate} --before=${beforeDate} --format=%H%x00%aI%x00%s --no-merges --max-count=200`.quiet();

    if (logResult.exitCode === 0) {
      const lines = logResult.text().trim().split("\n").filter(l => l.includes("\0"));
      const hashes: string[] = [];

      for (const line of lines) {
        const [hash, dateISO, message] = line.split("\0");
        if (!hash || !dateISO || !message) continue;
        const date = dateISO.slice(0, 10);
        hashes.push(hash);
        commits.push({ hash, date, message, branch: "", repoPath });
      }

      // Batch resolve branch names
      if (hashes.length > 0) {
        try {
          const nameRevResult = await $`echo ${hashes.join("\n")} | git -C ${repoPath} name-rev --stdin --name-only`.quiet();
          if (nameRevResult.exitCode === 0) {
            const branchLines = nameRevResult.text().trim().split("\n");
            for (let i = 0; i < Math.min(branchLines.length, commits.length); i++) {
              const branch = branchLines[i]?.replace(/[~^]\d+$/, "").replace(/^remotes\/origin\//, "") ?? "";
              commits[i]!.branch = branch;
            }
          }
        } catch {
          // Branch resolution is best-effort
        }
      }
      // Enrich commits with changed files and work type (max 20 commits)
      const enrichLimit = Math.min(commits.length, 20);
      for (let i = 0; i < enrichLimit; i++) {
        const c = commits[i]!;

        // Detect conventional commit prefix
        const prefixMatch = c.message.match(/^(feat|fix|refactor|test|docs|chore|style|perf|ci|build)(\(.+\))?[!]?:\s/);
        if (prefixMatch) {
          const prefix = prefixMatch[1]!;
          const typeMap: Record<string, string> = { feat: "feature", fix: "bugfix", refactor: "refactor", test: "test", docs: "docs", chore: "chore", style: "chore", perf: "feature", ci: "chore", build: "chore" };
          c.workType = typeMap[prefix] ?? prefix;
        }

        // Get changed files
        try {
          const diffResult = await $`git -C ${repoPath} diff --name-only ${c.hash}^..${c.hash}`.quiet();
          if (diffResult.exitCode === 0) {
            c.changedFiles = diffResult.text().trim().split("\n").filter(Boolean);
          }
        } catch { /* first commit or other edge case */ }
      }
    }
  } catch {
    // Repo may be empty or have issues
  }

  // Get uncommitted changes
  let uncommitted: GitUncommitted | null = null;
  try {
    const statusResult = await $`git -C ${repoPath} status --porcelain`.quiet();
    if (statusResult.exitCode === 0) {
      const statusLines = statusResult.text().trim().split("\n").filter(Boolean);
      const modifiedFiles: string[] = [];
      const stagedFiles: string[] = [];

      for (const line of statusLines) {
        const staged = line[0];
        const unstaged = line[1];
        const file = line.slice(3);
        if (staged && staged !== " " && staged !== "?") stagedFiles.push(file);
        if (unstaged && unstaged !== " ") modifiedFiles.push(file);
        if (staged === "?") modifiedFiles.push(file);
      }

      let linesAdded = 0;
      let linesRemoved = 0;
      try {
        const diffResult = await $`git -C ${repoPath} diff --shortstat`.quiet();
        const diffText = diffResult.text();
        const addMatch = diffText.match(/(\d+) insertion/);
        const delMatch = diffText.match(/(\d+) deletion/);
        if (addMatch) linesAdded = parseInt(addMatch[1]!, 10);
        if (delMatch) linesRemoved = parseInt(delMatch[1]!, 10);
      } catch { /* ignore */ }

      if (modifiedFiles.length > 0 || stagedFiles.length > 0) {
        uncommitted = { modifiedFiles, stagedFiles, linesAdded, linesRemoved };
      }
    }
  } catch { /* ignore */ }

  return { repoPath, commits, uncommitted };
}

export async function gatherGitEvidences(
  repoPaths: string[],
  from: string,
  to: string
): Promise<GitEvidence[]> {
  const results = await Promise.all(
    repoPaths.map(async (path) => {
      if (!(await isGitRepo(path))) return null;
      return scanRepo(path, from, to);
    })
  );
  return results.filter((r): r is GitEvidence => r !== null);
}

// ---------------------------------------------------------------------------
// Jira activity
// ---------------------------------------------------------------------------

export async function gatherJiraActivity(
  config: Config,
  from: string,
  to: string
): Promise<JiraEvidence> {
  // Run JQL queries in parallel
  const [transitionedIssues, sprintIssuesRaw] = await Promise.all([
    searchIssues(config, `assignee = currentUser() AND status changed DURING ("${from}", "${to}")`, 50).catch(() => [] as JiraIssue[]),
    searchIssues(config, `assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC`, 50).catch(() => [] as JiraIssue[]),
  ]);

  // Get changelogs for transitioned issues (limited concurrency)
  const statusTransitions: StatusTransition[] = [];
  const batchSize = 5;
  for (let i = 0; i < transitionedIssues.length; i += batchSize) {
    const batch = transitionedIssues.slice(i, i + batchSize);
    const changelogs = await Promise.all(
      batch.map(async (issue) => {
        try {
          const changelog = await getIssueChangelog(config, issue.key);
          return { issue, changelog };
        } catch {
          return { issue, changelog: [] };
        }
      })
    );

    for (const { issue, changelog } of changelogs) {
      for (const entry of changelog) {
        const entryDate = entry.created.slice(0, 10);
        if (entryDate < from || entryDate > to) continue;
        for (const item of entry.items) {
          if (item.field === "status") {
            statusTransitions.push({
              issueKey: issue.key,
              summary: issue.fields.summary,
              fromStatus: item.fromString ?? "",
              toStatus: item.toString ?? "",
              date: entryDate,
            });
          }
        }
      }
    }
  }

  // Sprint issues
  const sprintIssues = sprintIssuesRaw.map(issue => {
    const plainText = adfToPlainText(issue.fields.description);
    return {
      issueKey: issue.key,
      summary: issue.fields.summary,
      status: issue.fields.status.name,
      type: issue.fields.issuetype.name,
      estimate: issue.fields.timetracking?.originalEstimate ?? null,
      descriptionSnippet: plainText ? plainText.slice(0, 200) : null,
    };
  });

  // Find issues the user commented on in the date range
  const commentedIssues: Array<{ issueKey: string; summary: string; date: string }> = [];
  try {
    // Combine sprint + transitioned issues, deduplicate, fetch with comments
    const allIssueKeys = new Set([
      ...transitionedIssues.map(i => i.key),
      ...sprintIssuesRaw.map(i => i.key),
    ]);
    const issuesToCheck = [...allIssueKeys].slice(0, 20); // limit to avoid too many API calls
    for (let i = 0; i < issuesToCheck.length; i += batchSize) {
      const batch = issuesToCheck.slice(i, i + batchSize);
      const issuesWithComments = await Promise.all(
        batch.map(async (key) => {
          try {
            return await getIssue(config, key, true);
          } catch {
            return null;
          }
        })
      );
      for (const issue of issuesWithComments) {
        if (!issue?.fields.comment?.comments) continue;
        for (const comment of issue.fields.comment.comments) {
          if (comment.author.accountId !== config.accountId) continue;
          const commentDate = comment.created.slice(0, 10);
          if (commentDate < from || commentDate > to) continue;
          commentedIssues.push({
            issueKey: issue.key,
            summary: issue.fields.summary,
            date: commentDate,
          });
        }
      }
    }
  } catch { /* comments are optional enrichment */ }

  return { statusTransitions, sprintIssues, commentedIssues };
}

// ---------------------------------------------------------------------------
// Historical patterns
// ---------------------------------------------------------------------------

export async function gatherHistoricalPatterns(
  config: Config,
  from: string,
): Promise<HistoricalEvidence> {
  // Look back 3 months from the start date
  const startDate = new Date(`${from}T12:00:00`);
  const historyFrom = new Date(startDate);
  historyFrom.setMonth(historyFrom.getMonth() - 3);
  const historyFromStr = historyFrom.toISOString().slice(0, 10);

  // End one day before the target range
  const dayBefore = new Date(startDate);
  dayBefore.setDate(dayBefore.getDate() - 1);
  const historyToStr = dayBefore.toISOString().slice(0, 10);

  if (historyFromStr >= historyToStr) {
    return { recentWorklogs: [], recurringPatterns: [] };
  }

  let worklogs: TempoWorklog[];
  try {
    worklogs = await getWorklogsForRange(config, historyFromStr, historyToStr);
  } catch {
    return { recentWorklogs: [], recurringPatterns: [] };
  }

  // Resolve issue IDs to keys
  const issueIds = [...new Set(worklogs.map(w => w.issue.id))];
  let keyMap: Map<number, string>;
  try {
    keyMap = await getIssueKeysByIds(config, issueIds);
  } catch {
    keyMap = new Map();
  }

  // Build recent worklogs list
  const recentWorklogs = worklogs.map(w => ({
    issueKey: keyMap.get(w.issue.id) ?? String(w.issue.id),
    description: w.description,
    durationSeconds: w.timeSpentSeconds,
    date: w.startDate,
  }));

  // Detect recurring patterns
  // Group by issueKey + normalized description
  const groups = new Map<string, { issueKey: string; description: string; durations: number[]; dates: Set<string> }>();
  for (const wl of recentWorklogs) {
    const normalizedDesc = wl.description.toLowerCase().trim();
    const groupKey = `${wl.issueKey}::${normalizedDesc}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.durations.push(wl.durationSeconds);
      existing.dates.add(wl.date);
    } else {
      groups.set(groupKey, {
        issueKey: wl.issueKey,
        description: wl.description,
        durations: [wl.durationSeconds],
        dates: new Set([wl.date]),
      });
    }
  }

  // Calculate total working days in the history period for cadence detection
  const totalCalendarDays = Math.ceil((dayBefore.getTime() - historyFrom.getTime()) / 86400000);
  const approxWorkingDays = Math.floor(totalCalendarDays * 5 / 7);

  const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const recurringPatterns: RecurringPattern[] = [];
  for (const [, group] of groups) {
    const occurrences = group.dates.size;
    // Only consider patterns that appear at least 4 times (roughly once a week for a month)
    if (occurrences < 4) continue;

    const avgDuration = Math.round(group.durations.reduce((s, d) => s + d, 0) / group.durations.length);
    const frequency = occurrences / approxWorkingDays;

    let cadence: "daily" | "weekly" | "occasional";
    if (frequency >= 0.6) cadence = "daily";       // Appears 60%+ of working days
    else if (frequency >= 0.15) cadence = "weekly"; // Appears ~1-2x/week
    else cadence = "occasional";

    // Compute day-of-week distribution
    const dayOfWeekDistribution: Record<string, number> = {};
    for (const date of group.dates) {
      const dow = DOW_NAMES[new Date(`${date}T12:00:00`).getDay()]!;
      dayOfWeekDistribution[dow] = (dayOfWeekDistribution[dow] ?? 0) + 1;
    }

    // Determine primary days (days with 70%+ of occurrences)
    let primaryDays: string[] | undefined;
    if (cadence !== "daily") {
      const sorted = Object.entries(dayOfWeekDistribution).sort(([, a], [, b]) => b - a);
      let cumulative = 0;
      const candidates: string[] = [];
      for (const [day, count] of sorted) {
        cumulative += count;
        candidates.push(day);
        if (cumulative / occurrences >= 0.7) break;
      }
      if (candidates.length <= 2) {
        primaryDays = candidates;
      }
    }

    recurringPatterns.push({
      issueKey: group.issueKey,
      description: group.description,
      avgDurationSeconds: avgDuration,
      occurrences,
      totalDays: approxWorkingDays,
      cadence,
      dayOfWeekDistribution,
      primaryDays,
    });
  }

  // Sort by frequency (most frequent first)
  recurringPatterns.sort((a, b) => b.occurrences - a.occurrences);

  return { recentWorklogs, recurringPatterns };
}

// ---------------------------------------------------------------------------
// Repo auto-discovery
// ---------------------------------------------------------------------------

export async function discoverGitRepos(extraPaths: string[], scanDirs?: string[]): Promise<string[]> {
  const candidates = new Set<string>();

  // Always include cwd
  candidates.add(process.cwd());

  // Include project workdirs from projects.json
  const projects = loadProjects();
  for (const [, cfg] of Object.entries(projects)) {
    if (cfg.workingDir) {
      candidates.add(cfg.workingDir);
      // Also try parent dirs (workingDir may be inside a git repo)
      candidates.add(dirname(cfg.workingDir));
    }
  }

  // Include extra paths from --repo flag
  for (const p of extraPaths) {
    candidates.add(resolve(p));
  }

  // Scan configured directories for git repos (1-2 levels deep)
  if (scanDirs) {
    for (const dir of scanDirs) {
      try {
        const result = await $`find ${resolve(dir)} -maxdepth 2 -name .git -type d 2>/dev/null`.quiet();
        if (result.exitCode === 0) {
          for (const gitDir of result.text().trim().split("\n").filter(Boolean)) {
            candidates.add(dirname(gitDir));
          }
        }
      } catch { /* dir may not exist */ }
    }
  }

  // Resolve to git roots and deduplicate
  const roots = new Set<string>();
  await Promise.all(
    [...candidates].map(async (path) => {
      const root = await getGitRoot(path);
      if (root) roots.add(root);
    })
  );

  // For scanDir repos, filter to only those with recent activity (last 14 days)
  if (scanDirs) {
    const resolvedScanDirs = scanDirs.map(d => resolve(d));
    const activeRoots = new Set<string>();
    await Promise.all(
      [...roots].map(async (root) => {
        const isFromScanDir = resolvedScanDirs.some(sd => root.startsWith(sd));
        if (!isFromScanDir) {
          activeRoots.add(root); // Always include non-scanDir repos
          return;
        }
        // Check for recent commits
        try {
          const email = await getGitUserEmail(root);
          const result = await $`git -C ${root} log --oneline ${email ? `--author=${email}` : ""} --since="14 days ago" --max-count=1`.quiet();
          if (result.exitCode === 0 && result.text().trim()) {
            activeRoots.add(root);
          }
        } catch { /* skip inactive repos */ }
      })
    );
    return [...activeRoots];
  }

  return [...roots];
}

// ---------------------------------------------------------------------------
// Main evidence gatherer
// ---------------------------------------------------------------------------

export type ProgressCallback = (phase: string, message: string) => void;

export async function gatherAllEvidence(
  config: Config,
  repoPaths: string[],
  from: string,
  to: string,
  onProgress?: ProgressCallback,
): Promise<EvidenceBundle> {
  onProgress?.("git", `Scanning ${repoPaths.length} git repo(s)...`);
  const gitPromise = repoPaths.length > 0 ? gatherGitEvidences(repoPaths, from, to) : Promise.resolve([]);

  onProgress?.("jira", "Querying Jira status transitions and sprint issues...");
  const jiraPromise = gatherJiraActivity(config, from, to);

  onProgress?.("history", "Analyzing 3 months of historical worklogs...");
  const historyPromise = gatherHistoricalPatterns(config, from);

  onProgress?.("worklogs", "Loading existing worklogs...");
  const worklogsPromise = getWorklogsForRange(config, from, to);
  const daysPromise = getWorkingDays(config, from, to);

  // Google Calendar + Chat (only if connected)
  let googlePromise: Promise<GoogleEvidence | undefined> = Promise.resolve(undefined);
  if (isGoogleConnected()) {
    onProgress?.("google", "Fetching Google Calendar events and Chat activity...");
    googlePromise = (async () => {
      try {
        const [calendar, chat] = await Promise.all([
          getCalendarEvents(config, from, to),
          getChatActivity(config, from, to).catch(() => [] as ChatActivity[]),
        ]);
        return { calendar, chat };
      } catch {
        return undefined;
      }
    })();
  }

  const [gitSignals, jiraActivity, historicalPatterns, existingWorklogsRaw, workingDays, googleSignals] = await Promise.all([
    gitPromise, jiraPromise, historyPromise, worklogsPromise, daysPromise, googlePromise,
  ]);

  // Resolve existing worklog issue IDs to keys
  const existingIds = [...new Set(existingWorklogsRaw.map(w => w.issue.id))];
  let existingKeyMap: Map<number, string>;
  try {
    existingKeyMap = await getIssueKeysByIds(config, existingIds);
  } catch {
    existingKeyMap = new Map();
  }

  // Group existing worklogs by date
  const existingWorklogs = new Map<string, Array<{ issueKey: string; seconds: number; description: string }>>();
  for (const wl of existingWorklogsRaw) {
    const key = existingKeyMap.get(wl.issue.id) ?? String(wl.issue.id);
    const arr = existingWorklogs.get(wl.startDate) ?? [];
    arr.push({ issueKey: key, seconds: wl.timeSpentSeconds, description: wl.description });
    existingWorklogs.set(wl.startDate, arr);
  }

  return {
    dateRange: { from, to },
    workingDays,
    existingWorklogs,
    git: gitSignals,
    jiraActivity,
    historicalPatterns,
    google: googleSignals,
  };
}

// ---------------------------------------------------------------------------
// Evidence serialization (for LLM context)
// ---------------------------------------------------------------------------

export function serializeEvidence(
  evidence: EvidenceBundle,
  targetHours: number,
  userInstructions?: string,
): string {
  const lines: string[] = [];

  lines.push(`## Target: ${targetHours}h per working day`);
  lines.push("");

  // User instructions placed early so LLM considers them before processing evidence
  if (userInstructions?.trim()) {
    lines.push(`## User Instructions (HIGHEST PRIORITY — override defaults)`);
    lines.push(userInstructions.trim());
    lines.push("");
  }

  // Working days needing logs
  const daysNeedingLogs = evidence.workingDays.filter((date) => {
    const existing = evidence.existingWorklogs.get(date) ?? [];
    const totalSeconds = existing.reduce((s, w) => s + w.seconds, 0);
    return totalSeconds < targetHours * 3600;
  });
  lines.push(`## Working Days Needing Logs`);
  for (const date of daysNeedingLogs) {
    const existing = evidence.existingWorklogs.get(date) ?? [];
    const totalSeconds = existing.reduce((s, w) => s + w.seconds, 0);
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
      new Date(`${date}T12:00:00`).getDay()
    ];
    if (totalSeconds > 0) {
      lines.push(
        `- ${date} (${dow}) — ${formatDuration(totalSeconds)} already logged`,
      );
    } else {
      lines.push(`- ${date} (${dow}) — no logs`);
    }
  }
  lines.push("");

  // Recent worklog examples (last 10 working days before target range — few-shot for style/structure)
  if (evidence.historicalPatterns.recentWorklogs.length > 0) {
    const recentByDate = new Map<string, typeof evidence.historicalPatterns.recentWorklogs>();
    for (const wl of evidence.historicalPatterns.recentWorklogs) {
      if (wl.date >= evidence.dateRange.from) continue; // Only history, not current range
      const arr = recentByDate.get(wl.date) ?? [];
      arr.push(wl);
      recentByDate.set(wl.date, arr);
    }
    const recentDates = [...recentByDate.keys()].sort().reverse().slice(0, 10).reverse();
    if (recentDates.length > 0) {
      lines.push(`## Recent Worklog Examples (for style/structure reference)`);
      for (const date of recentDates) {
        const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
          new Date(`${date}T12:00:00`).getDay()
        ];
        const wls = recentByDate.get(date)!;
        const totalSec = wls.reduce((s, w) => s + w.durationSeconds, 0);
        lines.push(`### ${date} (${dow}) — ${formatDuration(totalSec)}`);
        for (const w of wls) {
          lines.push(`- ${w.issueKey} ${formatDuration(w.durationSeconds)} "${w.description}"`);
        }
      }
      lines.push("");
    }
  }

  // Git branch → issue mapping (pre-computed for LLM)
  if (evidence.git.length > 0) {
    const branchIssueMap = new Map<string, { issueKeys: Set<string>; commitCount: number; dates: Set<string>; repo: string }>();
    for (const repo of evidence.git) {
      const repoName = repo.repoPath.split("/").pop() ?? repo.repoPath;
      for (const c of repo.commits) {
        if (!c.branch) continue;
        const existing = branchIssueMap.get(c.branch) ?? { issueKeys: new Set(), commitCount: 0, dates: new Set(), repo: repoName };
        existing.commitCount++;
        existing.dates.add(c.date);
        for (const k of extractIssueKeys(c.branch)) existing.issueKeys.add(k);
        for (const k of extractIssueKeys(c.message)) existing.issueKeys.add(k);
        branchIssueMap.set(c.branch, existing);
      }
    }
    const mappings = [...branchIssueMap.entries()].filter(([, v]) => v.issueKeys.size > 0);
    if (mappings.length > 0) {
      lines.push(`## Git Branch → Issue Mapping`);
      for (const [branch, info] of mappings.sort(([, a], [, b]) => b.commitCount - a.commitCount)) {
        const dates = [...info.dates].sort();
        const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const dayRange = dates.map(d => DOW_NAMES[new Date(`${d}T12:00:00`).getDay()]).join(", ");
        lines.push(`- ${branch} → ${[...info.issueKeys].join(", ")} (${info.commitCount} commits, ${dayRange})`);
      }
      lines.push("");
    }
  }

  // Git activity
  if (evidence.git.length > 0) {
    lines.push(`## Git Activity`);
    for (const repo of evidence.git) {
      const repoName = repo.repoPath.split("/").pop() ?? repo.repoPath;
      lines.push(`### Repo: ${repoName}`);

      if (repo.commits.length > 0) {
        // Group by date
        const byDate = new Map<string, GitCommit[]>();
        for (const c of repo.commits) {
          const arr = byDate.get(c.date) ?? [];
          arr.push(c);
          byDate.set(c.date, arr);
        }
        for (const [date, commits] of [...byDate].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          lines.push(`#### ${date}`);
          for (const c of commits) {
            const branchInfo = c.branch ? ` (branch: ${c.branch})` : "";
            const typeInfo = c.workType ? ` [${c.workType}]` : "";
            const fileCount = c.changedFiles?.length
              ? ` (${c.changedFiles.length} files)`
              : "";
            lines.push(
              `- [${c.hash.slice(0, 7)}] ${c.message}${branchInfo}${typeInfo}${fileCount}`,
            );
          }
        }
      } else {
        lines.push("No commits in date range.");
      }
      lines.push("");
    }
  }

  // Multi-day work streams (issues spanning 2+ days)
  {
    const issueActivity = new Map<string, { dates: Set<string>; commits: number; transitions: string[]; summary: string }>();

    // Aggregate git commits by issue key across all days
    for (const repo of evidence.git) {
      for (const c of repo.commits) {
        const keys = [...extractIssueKeys(c.message), ...extractIssueKeys(c.branch)];
        for (const key of new Set(keys)) {
          const existing = issueActivity.get(key) ?? { dates: new Set(), commits: 0, transitions: [], summary: "" };
          existing.dates.add(c.date);
          existing.commits++;
          issueActivity.set(key, existing);
        }
      }
    }

    // Add status transitions
    for (const t of evidence.jiraActivity.statusTransitions) {
      const existing = issueActivity.get(t.issueKey) ?? { dates: new Set(), commits: 0, transitions: [], summary: t.summary };
      existing.dates.add(t.date);
      existing.transitions.push(`${t.fromStatus}→${t.toStatus} on ${t.date}`);
      if (!existing.summary) existing.summary = t.summary;
      issueActivity.set(t.issueKey, existing);
    }

    // Enrich summaries from sprint issues
    for (const si of evidence.jiraActivity.sprintIssues) {
      const existing = issueActivity.get(si.issueKey);
      if (existing && !existing.summary) existing.summary = si.summary;
    }

    // Filter to multi-day issues
    const multiDay = [...issueActivity.entries()]
      .filter(([, v]) => v.dates.size >= 2)
      .sort(([, a], [, b]) => b.dates.size - a.dates.size);

    if (multiDay.length > 0) {
      const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      lines.push(`## Multi-Day Work Streams (vary descriptions to show progression)`);
      for (const [key, info] of multiDay.slice(0, 10)) {
        const sortedDates = [...info.dates].sort();
        const days = sortedDates.map(d => DOW[new Date(`${d}T12:00:00`).getDay()]).join("→");
        const summary = info.summary ? ` "${info.summary}"` : "";
        const parts = [`${info.dates.size} days (${days})`];
        if (info.commits > 0) parts.push(`${info.commits} commits`);
        if (info.transitions.length > 0) parts.push(info.transitions.join(", "));
        lines.push(`- ${key}${summary}: ${parts.join(", ")}`);
      }
      lines.push("");
    }
  }

  // Jira status transitions
  if (evidence.jiraActivity.statusTransitions.length > 0) {
    lines.push(`## Jira Status Transitions`);
    for (const t of evidence.jiraActivity.statusTransitions) {
      lines.push(
        `- ${t.date}: ${t.issueKey} "${t.summary}" — ${t.fromStatus} → ${t.toStatus}`,
      );
    }
    lines.push("");
  }

  // Sprint issues
  if (evidence.jiraActivity.sprintIssues.length > 0) {
    lines.push(`## Active Sprint Issues (assigned to user)`);
    for (const issue of evidence.jiraActivity.sprintIssues) {
      const est = issue.estimate ? ` (est: ${issue.estimate})` : "";
      lines.push(
        `- ${issue.issueKey}: "${issue.summary}" [${issue.type}, ${issue.status}]${est}`,
      );
      if (issue.descriptionSnippet) {
        lines.push(`  Context: "${issue.descriptionSnippet}${issue.descriptionSnippet.length >= 200 ? "..." : ""}"`);
      }
    }
    lines.push("");
  }

  // User comments on issues
  if (evidence.jiraActivity.commentedIssues.length > 0) {
    lines.push(`## User Comments (evidence of engagement)`);
    for (const c of evidence.jiraActivity.commentedIssues) {
      lines.push(`- ${c.date}: ${c.issueKey} "${c.summary}"`);
    }
    lines.push("");
  }

  // Recurring patterns (annotate those covered by calendar events)
  if (evidence.historicalPatterns.recurringPatterns.length > 0) {
    // Build set of issue keys that appear in calendar events
    const calendarIssueKeys = new Set<string>();
    if (evidence.google?.calendar) {
      for (const e of evidence.google.calendar) {
        for (const k of extractIssueKeys(e.summary)) calendarIssueKeys.add(k);
      }
    }
    // Build set of calendar event summary keywords for fuzzy matching
    const calendarSummaries = new Set<string>();
    if (evidence.google?.calendar) {
      for (const e of evidence.google.calendar) {
        calendarSummaries.add(e.summary.toLowerCase().trim());
      }
    }

    lines.push(`## Recurring Worklog Patterns (from past 3 months)`);
    for (const p of evidence.historicalPatterns.recurringPatterns) {
      const dur = formatDuration(p.avgDurationSeconds);
      const dayInfo = p.primaryDays ? ` on ${p.primaryDays.join("/")}` : "";
      const coveredByCalendar = calendarIssueKeys.has(p.issueKey) ||
        calendarSummaries.has(p.description.toLowerCase().trim());
      const calTag = coveredByCalendar ? " [COVERED BY CALENDAR — skip if calendar event exists on that day]" : "";
      lines.push(
        `- ${p.issueKey} "${p.description}" — ${dur} avg, ${p.cadence}${dayInfo} (${p.occurrences}/${p.totalDays} days)${calTag}`,
      );
    }
    lines.push("");
  }

  // Google Calendar events
  if (evidence.google?.calendar && evidence.google.calendar.length > 0) {
    lines.push(`## Calendar Events`);
    const byDate = new Map<string, CalendarEvent[]>();
    for (const e of evidence.google.calendar) {
      if (e.isAllDay) continue;
      const arr = byDate.get(e.startDate) ?? [];
      arr.push(e);
      byDate.set(e.startDate, arr);
    }
    for (const [date, events] of [...byDate].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const totalSec = events.reduce((s, e) => s + e.durationSeconds, 0);
      lines.push(`### ${date}`);
      for (const e of events) {
        const attendees =
          e.attendeeCount > 0 ? ` (${e.attendeeCount} attendees)` : "";
        const dur = formatDuration(e.durationSeconds); // <-- ADD THIS
        lines.push(
          `- ${e.startTime}-${e.endTime} (${dur}) "${e.summary}"${attendees}`,
        ); // <-- UPDATE THIS
      }
      lines.push(`Total meeting time: ${formatDuration(totalSec)}`);
    }
    lines.push("");
  }

  // Google Chat activity (condensed)
  if (evidence.google?.chat && evidence.google.chat.length > 0) {
    lines.push(`## Chat Activity`);
    const byDate = new Map<string, { spaces: number; messages: number }>();
    for (const c of evidence.google.chat) {
      const existing = byDate.get(c.date) ?? { spaces: 0, messages: 0 };
      existing.spaces++;
      existing.messages += c.messageCount;
      byDate.set(c.date, existing);
    }
    for (const [date, stats] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`- ${date}: ${stats.messages} messages across ${stats.spaces} channels`);
    }
    lines.push("");
  }

  // Existing worklogs (so LLM knows what's already logged)
  const daysWithExisting = [...evidence.existingWorklogs.entries()].filter(
    ([, wls]) => wls.length > 0,
  );
  if (daysWithExisting.length > 0) {
    lines.push(`## Existing Worklogs (already logged — skip or supplement)`);
    for (const [date, wls] of daysWithExisting.sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`### ${date}`);
      for (const w of wls) {
        lines.push(
          `- ${w.issueKey} ${formatDuration(w.seconds)} ${w.description}`,
        );
      }
    }
    lines.push("");
  }

  // Known issue keys (aggregated from all sources)
  const allKeys = new Set<string>();
  for (const repo of evidence.git) {
    for (const c of repo.commits) {
      for (const k of extractIssueKeys(c.message)) allKeys.add(k);
      for (const k of extractIssueKeys(c.branch)) allKeys.add(k);
    }
  }
  for (const t of evidence.jiraActivity.statusTransitions)
    allKeys.add(t.issueKey);
  for (const i of evidence.jiraActivity.sprintIssues) allKeys.add(i.issueKey);
  for (const p of evidence.historicalPatterns.recurringPatterns)
    allKeys.add(p.issueKey);
  for (const [, wls] of evidence.existingWorklogs) {
    for (const w of wls) allKeys.add(w.issueKey);
  }

  // ---> ADD THIS BLOCK <---
  if (evidence.google?.calendar) {
    for (const e of evidence.google.calendar) {
      for (const k of extractIssueKeys(e.summary)) allKeys.add(k);
    }
  }
  // ------------------------

  // Historical time distribution per project
  if (evidence.historicalPatterns.recentWorklogs.length > 0) {
    const projectStats = new Map<string, { totalSeconds: number; daysActive: Set<string>; entryCount: number }>();
    for (const wl of evidence.historicalPatterns.recentWorklogs) {
      const projectKey = wl.issueKey.split("-")[0]!;
      const stats = projectStats.get(projectKey) ?? { totalSeconds: 0, daysActive: new Set(), entryCount: 0 };
      stats.totalSeconds += wl.durationSeconds;
      stats.daysActive.add(wl.date);
      stats.entryCount++;
      projectStats.set(projectKey, stats);
    }

    const sorted = [...projectStats.entries()]
      .filter(([, s]) => s.daysActive.size >= 3) // Only show projects with meaningful history
      .sort(([, a], [, b]) => b.totalSeconds - a.totalSeconds);

    if (sorted.length > 0) {
      lines.push(`## Typical Time Distribution (guide for allocation)`);
      for (const [proj, stats] of sorted.slice(0, 8)) {
        const avgDailyHours = (stats.totalSeconds / stats.daysActive.size / 3600).toFixed(1);
        const avgEntryDur = Math.round(stats.totalSeconds / stats.entryCount);
        lines.push(`- ${proj}: ~${avgDailyHours}h/day when active, typical entry ${formatDuration(avgEntryDur)} (active ${stats.daysActive.size} days)`);
      }
      lines.push("");
    }
  }

  if (allKeys.size > 0) {
    lines.push(`## Known Issue Keys (ONLY use these)`);
    lines.push([...allKeys].sort().join(", "));
    lines.push("");
  }

  // Preferred descriptions from SQLite (injected externally)
  // This section is appended by suggest.ts after calling getAllPreferredDescriptions()

  return lines.join("\n");
}
