import * as p from "@clack/prompts";
import pc from "picocolors";
import { setProjectConfig, loadProjects } from "../../lib/projects.ts";

export async function configureProjectWorkdir(
  projectKey?: string,
  workingDir?: string
): Promise<void> {
  let key = projectKey;
  if (!key) {
    const input = await p.text({ message: "Project key", placeholder: "RDM" });
    if (p.isCancel(input)) { p.cancel("Cancelled."); return; }
    key = (input as string).toUpperCase();
  }

  const existing = loadProjects()[key];

  let dir = workingDir;
  if (!dir) {
    const input = await p.text({
      message: "Working directory",
      placeholder: "/path/to/notes/jira/rdm",
      initialValue: existing?.workingDir ?? "",
    });
    if (p.isCancel(input)) { p.cancel("Cancelled."); return; }
    dir = input as string;
  }

  // If both key and path were provided non-interactively and project already exists,
  // just update the path without re-prompting for subfolders.
  if (projectKey && workingDir && existing) {
    setProjectConfig(key, { ...existing, workingDir: dir });
    p.log.success(pc.green(`✓ Saved config for ${key}`));
    return;
  }

  const useSubfolders = await p.confirm({
    message: "Use status subfolders? (Current/ and Done/)",
    initialValue: existing?.useStatusSubfolders ?? true,
  });
  if (p.isCancel(useSubfolders)) { p.cancel("Cancelled."); return; }

  setProjectConfig(key, { workingDir: dir, useStatusSubfolders: useSubfolders as boolean });
  p.log.success(pc.green(`✓ Saved config for ${key}`));
}
