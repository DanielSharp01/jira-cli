import * as p from "@clack/prompts";
import pc from "picocolors";
import { $ } from "bun";
import { loadConfig } from "../../lib/config.ts";
import { parseDateRange } from "../../lib/date-range.ts";
import { parseDuration } from "../../lib/duration.ts";
import { startServer } from "../../ui/server.ts";
import { discoverGitRepos } from "../../lib/signals.ts";

export async function tempoUI(
  fromArg?: string,
  toArg?: string,
  opts: {
    port?: number;
    repo?: string[];
    hours?: string;
    open?: boolean;
  } = {}
): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch {
    console.error("No config found. Run `jira config setup` first.");
    process.exit(1);
  }

  let range: { from: string; to: string };
  try {
    range = parseDateRange(fromArg ?? "week", toArg ?? "week-end");
  } catch (err) {
    p.log.error(String(err));
    process.exit(1);
  }

  let targetSeconds: number;
  try {
    targetSeconds = parseDuration(opts.hours ?? "8h");
  } catch {
    p.log.error(`Invalid --hours value "${opts.hours}"`);
    process.exit(1);
  }

  let repoPaths: string[] = [];
  try {
    const enabledDirs = (config.scanDirs ?? []).filter(d => d.enabled).map(d => d.path);
    repoPaths = await discoverGitRepos(opts.repo ?? [], enabledDirs);
  } catch {
    // Git discovery is optional
  }

  let port: number;
  try {
    ({ port } = startServer({
      config,
      defaultFrom: range.from,
      defaultTo: range.to,
      repoPaths,
      targetSecondsPerDay: targetSeconds,
      port: opts.port ?? 0,
    }));
  } catch (err) {
    console.error(`Failed to start server: ${String(err)}`);
    if (opts.port) console.error(`Port ${opts.port} may be in use. Try a different port: --port <number>`);
    process.exit(1);
  }

  const url = `http://localhost:${port}`;
  console.log(`\n  ${pc.bold("Tempo UI")} running at ${pc.cyan(url)}`);
  console.log(pc.dim("  Press Ctrl+C to stop\n"));

  if (opts.open !== false) {
    try {
      await $`xdg-open ${url}`.quiet();
    } catch {
      try {
        await $`open ${url}`.quiet();
      } catch {
        // Can't auto-open, user will navigate manually
      }
    }
  }

  // Keep process alive
  await new Promise(() => {});
}
