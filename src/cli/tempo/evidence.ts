import * as p from "@clack/prompts";
import { loadConfig } from "../../lib/config.ts";
import { parseDateRange } from "../../lib/date-range.ts";
import { parseDuration } from "../../lib/duration.ts";
import { discoverGitRepos, gatherAllEvidence, serializeEvidence } from "../../lib/evidence.ts";
import { SYSTEM_PROMPT } from "../../lib/suggest.ts";

export async function showEvidence(
  fromArg?: string,
  toArg?: string,
  opts: {
    repo?: string[];
    noGit?: boolean;
    hours?: string;
    prompt?: boolean;
    copy?: boolean;
  } = {}
): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch {
    p.log.error("No config found. Run `jira config setup` first.");
    process.exit(1);
  }

  let range: { from: string; to: string };
  try {
    range = parseDateRange(fromArg, toArg);
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
  const targetHours = targetSeconds / 3600;

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

  const spinner = p.spinner();
  spinner.start(`Gathering evidence for ${range.from} → ${range.to}...`);

  let evidence;
  try {
    evidence = await gatherAllEvidence(config, repoPaths, range.from, range.to);
  } catch (err) {
    spinner.stop("Failed");
    p.log.error(`Evidence gathering failed: ${String(err)}`);
    process.exit(1);
  }

  spinner.stop("Evidence gathered");

  const serialized = serializeEvidence(evidence, targetHours);

  if (opts.prompt) {
    const fullPrompt = `${SYSTEM_PROMPT}\n\n---\n\n${serialized}`;
    console.log(fullPrompt);

    if (opts.copy) {
      await copyToClipboard(fullPrompt);
    }
  } else {
    console.log(serialized);

    if (opts.copy) {
      await copyToClipboard(serialized);
    }
  }
}

async function copyToClipboard(text: string): Promise<void> {
  const commands = [
    ["xclip", "-selection", "clipboard"],
    ["pbcopy"],
    ["clip.exe"],
  ];
  for (const cmd of commands) {
    try {
      const proc = Bun.spawn(cmd, { stdin: "pipe" });
      proc.stdin.write(text);
      proc.stdin.end();
      await proc.exited;
      if (proc.exitCode === 0) {
        p.log.success("Copied to clipboard");
        return;
      }
    } catch {}
  }
  p.log.warn("Could not copy to clipboard (install xclip, or use pbcopy/clip.exe)");
}
