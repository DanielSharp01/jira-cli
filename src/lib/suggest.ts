import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { createSuggestLLM } from "./ai.ts";
import { SuggestResponseSchema } from "./suggest-schemas.ts";
import type { SuggestResponse } from "./suggest-schemas.ts";
import type { EvidenceBundle } from "./signals.ts";
import { serializeEvidence, extractIssueKeys } from "./signals.ts";
import { getAllPreferredDescriptions, getSuggestionFeedbackSummary } from "./db.ts";
import { parseDuration, formatDuration } from "./duration.ts";

const SYSTEM_PROMPT = `You are a developer's time-tracking assistant. Given evidence of their work activity, generate plausible Tempo worklog entries.

RULES:
1. Each working day should total exactly the target hours (usually 8h).
2. Only use issue keys from the KNOWN ISSUES list provided in the evidence. NEVER invent keys.
3. Round all durations to 15-minute increments (15m, 30m, 45m, 1h, 1h15m, etc.).
4. Do NOT suggest entries for days that already meet the target hours.
5. For partially logged days, suggest entries to fill the remaining hours only.
6. If an entry corresponds to a scheduled calendar meeting, provide its exact startTime (e.g. "14:30:00"). For general work, leave startTime null.
7. CALENDAR EVENTS ARE WORK: Log calendar events that occur during working hours. 
   - If the event title contains a known issue key, use that key.
   - If it does NOT contain a key, assign it to an internal overhead/meeting issue key from the KNOWN ISSUES list (prefer keys like INT-* or historically used meeting keys).
   - Use the event summary as the description.
   - Set confidence to "high" for calendar events.

DESCRIPTION STYLE:
- Write as a human developer. The description MUST sound like a person manually typing a brief summary of their day.
- NEVER include app context metadata, system artifacts, raw commit hashes, branch names, Jira keys, or status transitions in the text (e.g., absolutely NO "Transitioned PROJ-123 to Done", "Branch feature/x", or "Commit a1b2c3d").
- Match the user's writing style from their PREFERRED DESCRIPTIONS below.
- Reuse their exact phrasing when the work type is similar.
- When git commits exist, use the commit message as inspiration, but STRIP OUT system prefixes (like "feat:" or "fix:") and issue keys.
- If specific work context is missing or not enough evidence can be found, default to a generic, human-sounding description (e.g., "Development work", "Implementation", "Bug fixes", "Code review", "Project planning"). Do not try to guess specific details.
- Keep descriptions concise (3-8 words) and professional.

CONFIDENCE LEVELS:
- high: Direct evidence exists (git commit, status transition on that date)
- medium: Sprint assignment + related activity in the period, or recurring pattern match
- low: Inferred from patterns only, no direct evidence for that specific day

RECURRING PATTERNS:
- Historical recurring patterns are just FALLBACKS.
- NEVER use generic historical meeting patterns (e.g., "Monthly aggregate", "Weekly meetings") if you have actual Calendar Events for that day. 
- You may use specific daily recurring patterns (like "Daily Standup") only if they do not duplicate an existing Calendar Event.
- Internal tickets (INT-*) are overhead entries — add them for meetings and admin, then fill remaining hours with project work.

STRATEGY:
1. First, map actual scheduled Calendar Events. These are concrete evidence and take absolute highest precedence.
2. Second, map direct project evidence (git commits, Jira status transitions on that specific date).
3. Third, fill remaining hours using active sprint issues based on the user's general activity.
4. Finally, use recurring patterns ONLY to fill gaps when no direct evidence or calendar events explain the remaining time.
5. Vary descriptions slightly day-to-day for project work (don't repeat the exact same text every day).

MULTI-DAY WORK:
- When an issue spans multiple consecutive days, vary the descriptions to reflect progression.
- Use words like "initial", "continued", "finalized", "testing", "review" to show evolution.
- Don't repeat the exact same description across consecutive days for the same issue.

EXAMPLE (adapt to actual evidence):
Given: Monday, 8h target, 0h logged. Calendar: "Sprint Planning" 10:00-11:00. Git: 3 commits on PROJ-42 branch feature/PROJ-42-auth. Pattern: INT-7 "Daily standup" daily 15m. Sprint: PROJ-42 "Auth flow" In Progress, PROJ-50 "API docs" To Do.
→
  INT-7      "Daily standup"          15m   startTime:09:00:00  confidence:high   (daily pattern)
  INT-2      "Sprint planning"        1h    startTime:10:00:00  confidence:high   (calendar event)
  PROJ-42    "Auth flow implementation" 5h  startTime:null       confidence:high   (3 git commits)
  PROJ-50    "API documentation review" 1h45m startTime:null     confidence:medium (sprint issue, no direct evidence)
  Total: 8h ✓`;

/**
 * Post-inference validation and auto-fix for LLM output.
 * - Removes entries with unknown issue keys
 * - Ensures durations are multiples of 15 minutes
 * - Adjusts day totals to match target hours
 */
function validateAndFix(
  response: SuggestResponse,
  knownKeys: Set<string>,
  targetHours: number,
): SuggestResponse {
  const targetSeconds = targetHours * 3600;

  for (const day of response.days) {
    // Remove entries with unknown issue keys
    day.entries = day.entries.filter(e => knownKeys.has(e.issueKey));

    // Round durations to nearest 15 minutes
    for (const entry of day.entries) {
      const seconds = parseDuration(entry.durationHuman);
      const rounded = Math.round(seconds / 900) * 900;
      if (rounded !== seconds && rounded > 0) {
        entry.durationHuman = formatDuration(rounded);
      }
    }

    // Adjust total to match target hours
    if (day.entries.length > 0) {
      const currentTotal = day.entries.reduce((s, e) => s + parseDuration(e.durationHuman), 0);
      const diff = targetSeconds - currentTotal;

      // Only auto-fix if within 1h of target (avoid large distortions)
      if (diff !== 0 && Math.abs(diff) <= 3600) {
        // Adjust the longest non-meeting entry
        const adjustable = [...day.entries]
          .filter(e => !e.startTime) // Don't adjust calendar events
          .sort((a, b) => parseDuration(b.durationHuman) - parseDuration(a.durationHuman));

        if (adjustable.length > 0) {
          const target = adjustable[0]!;
          const currentDur = parseDuration(target.durationHuman);
          const newDur = currentDur + diff;
          // Round to 15m and ensure at least 15m
          const rounded = Math.max(900, Math.round(newDur / 900) * 900);
          target.durationHuman = formatDuration(rounded);
        }
      }

      // Recalculate totalHours
      day.totalHours = day.entries.reduce((s, e) => s + parseDuration(e.durationHuman), 0) / 3600;
    }
  }

  // Remove empty days
  response.days = response.days.filter(d => d.entries.length > 0);

  return response;
}

/**
 * Pre-process user instructions to detect vacation/PTO patterns and remove those
 * dates from the working days list before sending to the LLM.
 */
function preprocessInstructions(
  instructions: string | undefined,
  evidence: EvidenceBundle,
): string | undefined {
  if (!instructions?.trim()) return instructions;

  // Detect vacation/PTO/off patterns like "vacation on 2026-03-20" or "PTO March 17-18"
  const vacationRe = /\b(?:vacation|pto|off|holiday|sick|leave)\b.*?(\d{4}-\d{2}-\d{2}(?:\s*(?:to|-|–)\s*\d{4}-\d{2}-\d{2})?)/gi;
  let match;
  while ((match = vacationRe.exec(instructions)) !== null) {
    const dateStr = match[1]!;
    const parts = dateStr.split(/\s*(?:to|-|–)\s*/);
    const startDate = parts[0]!;
    const endDate = parts[1] ?? startDate;

    // Remove matching dates from working days
    evidence.workingDays = evidence.workingDays.filter(d => d < startDate || d > endDate);
  }

  return instructions;
}

export async function generateSuggestions(
  evidence: EvidenceBundle,
  targetHoursPerDay: number,
  model?: string,
  userInstructions?: string,
): Promise<SuggestResponse> {
  const llm = createSuggestLLM(model);
  const structuredLlm = llm.withStructuredOutput(SuggestResponseSchema);

  // Pre-process instructions (may modify evidence.workingDays for vacation/PTO)
  const processedInstructions = preprocessInstructions(userInstructions, evidence);

  let evidenceContext = serializeEvidence(evidence, targetHoursPerDay, processedInstructions);

  // Inject preferred descriptions from SQLite
  try {
    const prefs = getAllPreferredDescriptions(50);
    if (prefs.length > 0) {
      const grouped = new Map<string, string[]>();
      for (const p of prefs) {
        const arr = grouped.get(p.issueKey) ?? [];
        arr.push(`"${p.description}" (${p.usageCount}x)`);
        grouped.set(p.issueKey, arr);
      }
      evidenceContext += "\n## User's Preferred Descriptions\n";
      for (const [key, descs] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
        evidenceContext += `- ${key}: ${descs.join(", ")}\n`;
      }
    }
  } catch {
    // SQLite is optional enrichment
  }

  // Inject suggestion feedback from past corrections
  try {
    const feedback = getSuggestionFeedbackSummary(15);
    const actionable = feedback.filter(f => f.rejected > 0 || f.modified > 0 || f.commonCorrections.length > 0);
    if (actionable.length > 0) {
      evidenceContext += "\n## Past Suggestion Accuracy (learn from corrections)\n";
      for (const f of actionable) {
        const parts: string[] = [`${f.issueKey}: ${f.accepted}/${f.totalSuggested} accepted`];
        if (f.rejected > 0) parts.push(`${f.rejected} rejected`);
        if (f.modified > 0) parts.push(`${f.modified} modified`);
        if (f.avgDurationCorrection && Math.abs(f.avgDurationCorrection) >= 900) {
          const dir = f.avgDurationCorrection > 0 ? "increased" : "decreased";
          parts.push(`user typically ${dir} duration by ${formatDuration(Math.abs(f.avgDurationCorrection))}`);
        }
        evidenceContext += `- ${parts.join(", ")}\n`;
        for (const c of f.commonCorrections) {
          evidenceContext += `  → ${c}\n`;
        }
      }
    }
  } catch {
    // Feedback is optional enrichment
  }

  const result = await structuredLlm.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(evidenceContext),
  ]);

  // Compute known issue keys for validation
  const knownKeys = new Set<string>();
  for (const repo of evidence.git) {
    for (const c of repo.commits) {
      for (const k of extractIssueKeys(c.message)) knownKeys.add(k);
      for (const k of extractIssueKeys(c.branch)) knownKeys.add(k);
    }
  }
  for (const t of evidence.jiraActivity.statusTransitions) knownKeys.add(t.issueKey);
  for (const i of evidence.jiraActivity.sprintIssues) knownKeys.add(i.issueKey);
  for (const p of evidence.historicalPatterns.recurringPatterns) knownKeys.add(p.issueKey);
  for (const [, wls] of evidence.existingWorklogs) {
    for (const w of wls) knownKeys.add(w.issueKey);
  }
  if (evidence.google?.calendar) {
    for (const e of evidence.google.calendar) {
      for (const k of extractIssueKeys(e.summary)) knownKeys.add(k);
    }
  }

  return validateAndFix(result, knownKeys, targetHoursPerDay);
}
