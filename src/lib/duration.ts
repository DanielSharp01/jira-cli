/**
 * Parses a human duration string into seconds.
 * Supported formats: "2h", "30m", "1h30m", "1.5h", "0.5h"
 */
export function parseDuration(input: string): number {
  const normalized = input.trim().toLowerCase();

  // "1h30m" or "1h" or "30m"
  const hm = normalized.match(/^(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?$/);
  if (hm && (hm[1] !== undefined || hm[2] !== undefined)) {
    const hours = parseFloat(hm[1] ?? "0");
    const minutes = parseFloat(hm[2] ?? "0");
    return Math.round((hours * 3600) + (minutes * 60));
  }

  throw new Error(
    `Invalid duration "${input}". Use formats like: 2h, 30m, 1h30m, 1.5h`
  );
}

/**
 * Formats seconds back to a human-readable string.
 */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}
