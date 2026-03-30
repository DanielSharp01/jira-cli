import { $ } from "bun";

export async function openInBrowser(url: string): Promise<boolean> {
  if (process.env.WSL_DISTRO_NAME) {
    try { await $`wslview ${url}`.quiet(); return true; } catch {}
    try { await $`cmd.exe /c start ${url}`.quiet(); return true; } catch {}
  }
  try { await $`xdg-open ${url}`.quiet(); return true; } catch {}
  try { await $`open ${url}`.quiet(); return true; } catch {}
  return false;
}
