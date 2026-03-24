import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { createSuggestLLM } from "./ai.ts";
import { SuggestResponseSchema } from "./suggest-schemas.ts";
import type { SuggestResponse } from "./suggest-schemas.ts";
import type { EvidenceBundle } from "./signals.ts";
import { serializeEvidence } from "./signals.ts";
import { getAllPreferredDescriptions } from "./db.ts";

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
5. Vary descriptions slightly day-to-day for project work (don't repeat the exact same text every day).`;

export async function generateSuggestions(
  evidence: EvidenceBundle,
  targetHoursPerDay: number,
  model?: string,
  userInstructions?: string,
): Promise<SuggestResponse> {
  const llm = createSuggestLLM(model);
  const structuredLlm = llm.withStructuredOutput(SuggestResponseSchema);

  let evidenceContext = serializeEvidence(evidence, targetHoursPerDay);

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

  if (userInstructions?.trim()) {
    evidenceContext += `\n## User Instructions\n${userInstructions.trim()}\n`;
  }

  const result = await structuredLlm.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(evidenceContext),
  ]);

  return result;
}
