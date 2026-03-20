import * as p from "@clack/prompts";
import pc from "picocolors";
import { saveConfig, loadConfig, configExists, resolvePat } from "../lib/config.ts";
import { getMyself } from "../lib/jira.ts";
import type { Config } from "../lib/types.ts";

const SETTABLE_KEYS = ["baseUrl", "authType", "email", "jiraPat", "tempoPat", "workingDir"] as const;
const READONLY_KEYS = ["accountId"] as const;
type SettableKey = typeof SETTABLE_KEYS[number];
type ReadonlyKey = typeof READONLY_KEYS[number];

function isSettable(key: string): key is SettableKey {
  return (SETTABLE_KEYS as readonly string[]).includes(key);
}

function isReadonly(key: string): key is ReadonlyKey {
  return (READONLY_KEYS as readonly string[]).includes(key);
}

export async function runConfig(key?: string, value?: string): Promise<void> {
  // jira config <key> → print current value
  if (key && !value) {
    if (!configExists()) {
      p.log.error("No config found. Run `jira config` to set up.");
      process.exit(1);
    }
    const config = loadConfig();
    if (!isSettable(key) && !isReadonly(key)) {
      p.log.error(`Unknown config key "${key}". Valid keys: ${[...SETTABLE_KEYS, ...READONLY_KEYS].join(", ")}`);
      process.exit(1);
    }
    const val = config[key as keyof Config];
    console.log(val !== undefined ? String(val) : "(not set)");
    return;
  }

  // jira config <key> <value> → set and save
  if (key && value) {
    if (!isSettable(key)) {
      if (isReadonly(key)) {
        p.log.error(`"${key}" is read-only (auto-set during config setup).`);
      } else {
        p.log.error(`Unknown settable key "${key}". Settable: ${SETTABLE_KEYS.join(", ")}`);
      }
      process.exit(1);
    }
    let config: Config;
    if (configExists()) {
      config = loadConfig();
    } else {
      p.log.error("No config found. Run `jira config` to set up first.");
      process.exit(1);
    }
    (config as unknown as Record<string, unknown>)[key] = value;
    saveConfig(config);
    p.log.success(`Set ${key} = ${value}`);
    return;
  }

  // jira config (interactive wizard)
  p.intro(pc.bgCyan(pc.black(" jira config ")));

  let existing: Partial<Config> = {};
  if (configExists()) {
    try {
      existing = loadConfig();
    } catch {
      // ignore
    }
  }

  const baseUrl = await p.text({
    message: "JIRA base URL",
    placeholder: "https://company.atlassian.net",
    initialValue: existing.baseUrl ?? "",
    validate: (v) => (v == null || !v.startsWith("http") ? "Must be a valid URL" : undefined),
  });
  if (p.isCancel(baseUrl)) { p.cancel("Cancelled."); process.exit(0); }

  const authType = await p.select<"cloud" | "datacenter">({
    message: "JIRA deployment type",
    options: [
      { value: "cloud", label: "Cloud (atlassian.net)", hint: "Basic auth: email + API token" },
      { value: "datacenter", label: "Data Center / Server", hint: "Bearer auth: PAT" },
    ],
    initialValue: existing.authType ?? "cloud",
  });
  if (p.isCancel(authType)) { p.cancel("Cancelled."); process.exit(0); }

  let email: string | undefined;
  if (authType === "cloud") {
    const emailInput = await p.text({
      message: "Your Atlassian email",
      placeholder: "you@company.com",
      initialValue: existing.email ?? "",
      validate: (v) => (v == null || !v.includes("@") ? "Must be a valid email" : undefined),
    });
    if (p.isCancel(emailInput)) { p.cancel("Cancelled."); process.exit(0); }
    email = emailInput as string;
  }

  const jiraPat = await p.text({
    message: authType === "cloud" ? "JIRA API token (or $ENV_VAR reference)" : "JIRA PAT (or $ENV_VAR reference)",
    placeholder: "$JIRA_PAT",
    initialValue: existing.jiraPat ?? "$JIRA_PAT",
    validate: (v) => (v == null || !v.trim() ? "Required" : undefined),
  });
  if (p.isCancel(jiraPat)) { p.cancel("Cancelled."); process.exit(0); }

  const tempoPat = await p.text({
    message: "Tempo PAT (or $ENV_VAR reference)",
    placeholder: "$TEMPO_PAT",
    initialValue: existing.tempoPat ?? "$TEMPO_PAT",
    validate: (v) => (v == null || !v.trim() ? "Required" : undefined),
  });
  if (p.isCancel(tempoPat)) { p.cancel("Cancelled."); process.exit(0); }

  // Resolve PAT and verify credentials via /myself
  const spinner = p.spinner();
  spinner.start("Verifying credentials…");

  let accountId: string;
  let displayName: string;
  try {
    const resolvedPat = resolvePat(jiraPat as string, "JIRA_PAT");
    const cleanBaseUrl = (baseUrl as string).replace(/\/$/, "");
    const me = await getMyself(cleanBaseUrl, resolvedPat, authType as "cloud" | "datacenter", email);
    accountId = me.accountId;
    displayName = me.displayName;
    spinner.stop(`Verified: ${pc.bold(displayName)}`);
  } catch (err) {
    spinner.stop("Verification failed");
    p.log.error(String(err));
    process.exit(1);
  }

  const config: Config = {
    baseUrl: (baseUrl as string).replace(/\/$/, ""),
    accountId,
    email,
    authType: authType as "cloud" | "datacenter",
    jiraPat: jiraPat as string,
    tempoPat: tempoPat as string,
  };

  saveConfig(config);

  p.outro(pc.green("✓ Config saved to ~/.config/jira-cli/config.json"));
}
