import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface ProjectConfig {
  workingDir: string;
  useStatusSubfolders?: boolean;
}

const CONFIG_DIR = join(homedir(), ".config", "jira-cli");
const PROJECTS_FILE = join(CONFIG_DIR, "projects.json");

export function getProjectKey(issueKey: string): string {
  return issueKey.split("-")[0] ?? issueKey;
}

export function loadProjects(): Record<string, ProjectConfig> {
  if (!existsSync(PROJECTS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(PROJECTS_FILE, "utf-8")) as Record<string, ProjectConfig>;
  } catch {
    return {};
  }
}

export function saveProjects(projects: Record<string, ProjectConfig>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), "utf-8");
}

export function getProjectConfig(issueKey: string): ProjectConfig | null {
  const key = getProjectKey(issueKey);
  return loadProjects()[key] ?? null;
}

export function setProjectConfig(projectKey: string, cfg: ProjectConfig): void {
  const projects = loadProjects();
  projects[projectKey] = cfg;
  saveProjects(projects);
}

/** Full output path for an issue given its statusCategory key ("done" | other) */
export function resolveIssuePath(issueKey: string, statusCategoryKey: string): string {
  const cfg = getProjectConfig(issueKey);
  if (!cfg) return join(process.cwd(), `${issueKey}.md`);
  if (cfg.useStatusSubfolders) {
    const subfolder = statusCategoryKey === "done" ? "Done" : "Current";
    return join(cfg.workingDir, subfolder, `${issueKey}.md`);
  }
  return join(cfg.workingDir, `${issueKey}.md`);
}
