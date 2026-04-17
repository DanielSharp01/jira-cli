import { z } from "zod";

export const SuggestedWorklogSchema = z.object({
  issueKey: z.string().describe("JIRA issue key, e.g. PROJ-123 or INT-7"),
  description: z.string().describe("Concise worklog description (3-8 words)"),
  durationHuman: z.string().describe("Duration as human string like '2h' or '1h30m' (multiples of 15m)"),
  confidence: z.enum(["high", "medium", "low"]).describe(
    "high = direct evidence (git commit, status transition); medium = sprint assignment + related activity; low = inferred from patterns only"
  ),
  reasoning: z.string().describe("Brief explanation of why this entry is suggested"),
  startTime: z.string().nullable().describe("Optional exact start time in HH:MM:SS format. ONLY set this for rigid scheduled events like Calendar Meetings where the time is strictly known. Otherwise, leave null."),
});

export const DaySuggestionsSchema = z.object({
  date: z.string().describe("ISO date YYYY-MM-DD"),
  entries: z.array(SuggestedWorklogSchema),
  totalHours: z.number().describe("Total hours suggested for this day"),
});

export const SuggestResponseSchema = z.object({
  days: z.array(DaySuggestionsSchema),
});

export type SuggestedWorklog = z.infer<typeof SuggestedWorklogSchema>;
export type DaySuggestions = z.infer<typeof DaySuggestionsSchema>;
export type SuggestResponse = z.infer<typeof SuggestResponseSchema>;
