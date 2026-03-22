import * as p from "@clack/prompts";
import pc from "picocolors";
import { saveConfig, loadConfig, configExists, resolvePat } from "../lib/config.ts";
import { getMyself } from "../lib/jira.ts";
import type { Config, TableWidths } from "../lib/types.ts";

// ---------------------------------------------------------------------------
// Key registry
// ---------------------------------------------------------------------------

interface KeyDef {
  label: string;
  hint?: string;
  prompt(config: Config): Promise<unknown | symbol>;
  get(config: Config): unknown;
  set(config: Config, value: unknown): void;
}

const READONLY_KEYS = ["accountId"] as const;
type ReadonlyKey = typeof READONLY_KEYS[number];

function isReadonly(key: string): key is ReadonlyKey {
  return (READONLY_KEYS as readonly string[]).includes(key);
}

/** Infer whether a key is a namespace (has registered dot-notation sub-keys). */
function isNamespace(key: string): boolean {
  return Object.keys(KEY_DEFS).some((k) => k.startsWith(key + "."));
}

const TABLE_COL_DEFAULTS: Required<TableWidths> = { key: 13, type: 10, status: 22, sprint: 16, estimate: 8, summary: 58 };

// ---------------------------------------------------------------------------
// Flat key prompt helpers
// ---------------------------------------------------------------------------

async function promptBaseUrl(config: Config): Promise<string | symbol> {
  return p.text({
    message: "JIRA base URL",
    placeholder: "https://company.atlassian.net",
    initialValue: config.baseUrl ?? "",
    validate: (v) => (!v?.startsWith("http") ? "Must be a valid URL" : undefined),
  });
}

async function promptAuthType(config: Config): Promise<string | symbol> {
  return p.select<"cloud" | "datacenter">({
    message: "Deployment type",
    options: [
      { value: "cloud",      label: "Cloud (atlassian.net)",  hint: "Basic auth: email + API token" },
      { value: "datacenter", label: "Data Center / Server",   hint: "Bearer auth: PAT" },
    ],
    initialValue: config.authType ?? "cloud",
  });
}

async function promptEmail(config: Config): Promise<string | symbol> {
  return p.text({
    message: "Atlassian email",
    placeholder: "you@company.com",
    initialValue: config.email ?? "",
    validate: (v) => (!v?.includes("@") ? "Must be a valid email" : undefined),
  });
}

async function promptJiraPat(config: Config): Promise<string | symbol> {
  return p.text({
    message: "JIRA PAT / API token (or $ENV_VAR reference)",
    placeholder: "$JIRA_PAT",
    initialValue: config.jiraPat ?? "$JIRA_PAT",
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
}

async function promptTempoPat(config: Config): Promise<string | symbol> {
  return p.text({
    message: "Tempo PAT (or $ENV_VAR reference)",
    placeholder: "$TEMPO_PAT",
    initialValue: config.tempoPat ?? "$TEMPO_PAT",
    validate: (v) => (!v?.trim() ? "Required" : undefined),
  });
}

// ---------------------------------------------------------------------------
// Table widths editor + sub-key helper
// ---------------------------------------------------------------------------

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

function renderExampleRow(tw: Required<TableWidths>): string {
  const header = [
    pad("KEY",      tw.key),
    pad("TYPE",     tw.type),
    pad("STATUS",   tw.status),
    pad("SPRINT",   tw.sprint),
    pad("ESTIMATE", tw.estimate),
    pad("SUMMARY",  tw.summary),
  ].join("  ");
  const row = [
    pad("ABC-123",       tw.key),
    pad("Story",         tw.type),
    pad("In Progress",   tw.status),
    pad("Sprint 42",     tw.sprint),
    pad("3h",            tw.estimate),
    pad("Fix the thing that does the stuff", tw.summary),
  ].join("  ");
  return `  ${pc.dim(`${header}  |`)}\n  ${row}  |`;
}

async function promptTableWidthColumn(col: keyof TableWidths, config: Config): Promise<number | symbol> {
  const current = (config.tableWidths?.[col] ?? TABLE_COL_DEFAULTS[col]);
  const input = await p.text({
    message: `Width for "${col}"`,
    initialValue: String(current),
    validate: (v) => {
      const n = parseInt(v ?? "", 10);
      return isNaN(n) || n < 4 ? "Must be an integer >= 4" : undefined;
    },
  });
  if (p.isCancel(input)) return input;
  return parseInt(input as string, 10);
}

async function runTableWidthsEditor(config: Config): Promise<Required<TableWidths> | symbol> {
  const TABLE_COLS = ["key", "type", "status", "sprint", "estimate", "summary"] as const;
  const pending: Required<TableWidths> = { ...TABLE_COL_DEFAULTS, ...config.tableWidths };
  console.log("\n" + renderExampleRow(pending) + "\n");

  while (true) {
    const options: { value: string; label: string; hint?: string }[] = TABLE_COLS.map((col) => ({
      value: `tableWidths.${col}`,
      label: col,
      hint:  `current: ${pending[col]}`,
    }));
    options.push({ value: "__done__", label: "Done", hint: "save changes" });

    const selected = await p.select({ message: "Adjust a column", options });
    if (p.isCancel(selected) || selected === "__done__") {
      if (p.isCancel(selected)) return selected as symbol;
      break;
    }

    const col = (selected as string).slice("tableWidths.".length) as keyof TableWidths;
    const newVal = await promptTableWidthColumn(col, { ...config, tableWidths: pending });
    if (p.isCancel(newVal)) return newVal as symbol;
    pending[col] = newVal as number;
    console.log("\n" + renderExampleRow(pending) + "\n");
  }

  return pending;
}

// ---------------------------------------------------------------------------
// KEY_DEFS — single source of truth
// ---------------------------------------------------------------------------

const KEY_DEFS: Record<string, KeyDef> = {
  baseUrl: {
    label: "JIRA base URL",
    prompt: promptBaseUrl,
    get: (c) => c.baseUrl,
    set: (c, v) => { c.baseUrl = (v as string).replace(/\/$/, ""); },
  },
  authType: {
    label: "Deployment type",
    prompt: promptAuthType,
    get: (c) => c.authType,
    set: (c, v) => { c.authType = v as "cloud" | "datacenter"; },
  },
  email: {
    label: "Atlassian email",
    prompt: promptEmail,
    get: (c) => c.email,
    set: (c, v) => { c.email = v as string; },
  },
  jiraPat: {
    label: "JIRA PAT / API token",
    prompt: promptJiraPat,
    get: (c) => c.jiraPat,
    set: (c, v) => { c.jiraPat = v as string; },
  },
  tempoPat: {
    label: "Tempo PAT",
    prompt: promptTempoPat,
    get: (c) => c.tempoPat,
    set: (c, v) => { c.tempoPat = v as string; },
  },
  tableWidths: {
    label: "Table column widths",
    hint:  "customize column widths",
    prompt: runTableWidthsEditor,
    get: (c) => c.tableWidths,
    set: (c, v) => { c.tableWidths = v as TableWidths; },
  },
  "tableWidths.key": {
    label: "Key column width",
    prompt: (c) => promptTableWidthColumn("key", c),
    get: (c) => c.tableWidths?.key,
    set: (c, v) => { c.tableWidths = { ...c.tableWidths, key: v as number }; },
  },
  "tableWidths.type": {
    label: "Type column width",
    prompt: (c) => promptTableWidthColumn("type", c),
    get: (c) => c.tableWidths?.type,
    set: (c, v) => { c.tableWidths = { ...c.tableWidths, type: v as number }; },
  },
  "tableWidths.status": {
    label: "Status column width",
    prompt: (c) => promptTableWidthColumn("status", c),
    get: (c) => c.tableWidths?.status,
    set: (c, v) => { c.tableWidths = { ...c.tableWidths, status: v as number }; },
  },
  "tableWidths.sprint": {
    label: "Sprint column width",
    prompt: (c) => promptTableWidthColumn("sprint", c),
    get: (c) => c.tableWidths?.sprint,
    set: (c, v) => { c.tableWidths = { ...c.tableWidths, sprint: v as number }; },
  },
  "tableWidths.estimate": {
    label: "Estimate column width",
    prompt: (c) => promptTableWidthColumn("estimate", c),
    get: (c) => c.tableWidths?.estimate,
    set: (c, v) => { c.tableWidths = { ...c.tableWidths, estimate: v as number }; },
  },
  "tableWidths.summary": {
    label: "Summary column width",
    prompt: (c) => promptTableWidthColumn("summary", c),
    get: (c) => c.tableWidths?.summary,
    set: (c, v) => { c.tableWidths = { ...c.tableWidths, summary: v as number }; },
  },
};

// Top-level (non-dot) keys + readonly keys, used for `getConfig` display
const ALL_DISPLAY_KEYS = [
  ...Object.keys(KEY_DEFS).filter((k) => !k.includes(".")),
  ...READONLY_KEYS,
];

// ---------------------------------------------------------------------------
// promptForKey — unified dispatcher
// ---------------------------------------------------------------------------

export async function promptForKey(key: string, config: Config): Promise<unknown | symbol> {
  const def = KEY_DEFS[key];
  if (!def) throw new Error(`No KeyDef registered for "${key}"`);
  return def.prompt(config);
}

// ---------------------------------------------------------------------------
// jira config get [key]
// ---------------------------------------------------------------------------

export async function getConfig(key?: string): Promise<void> {
  if (!configExists()) {
    p.log.error("No config found. Run `jira config` to set up.");
    process.exit(1);
  }
  const config = loadConfig();

  if (key) {
    if (!KEY_DEFS[key] && !isReadonly(key)) {
      p.log.error(`Unknown config key "${key}". Valid keys: ${ALL_DISPLAY_KEYS.join(", ")}`);
      process.exit(1);
    } else if (isNamespace(key)) {
      for (const [subKey, subDef] of Object.entries(KEY_DEFS)) {
        if (!subKey.startsWith(`${key}.`)) continue;
        const col = subKey.slice(key.length + 1);
        const v = subDef.get(config) ?? TABLE_COL_DEFAULTS[col as keyof TableWidths];
        console.log(`  ${col}: ${v}`);
      }
    } else {
      const val = isReadonly(key)
        ? config[key as keyof Config]
        : KEY_DEFS[key]!.get(config);
      console.log(val !== undefined ? String(val) : "(not set)");
    }
    return;
  }

  p.intro(pc.bgCyan(pc.black(" jira config ")));
  const rows: [string, string][] = [];
  for (const k of ALL_DISPLAY_KEYS) {
    if (isNamespace(k)) {
      rows.push([pc.bold(k), ""]);
      for (const [subKey, subDef] of Object.entries(KEY_DEFS)) {
        if (!subKey.startsWith(k + ".")) continue;
        const col = subKey.slice(k.length + 1);
        const v = subDef.get(config) ?? TABLE_COL_DEFAULTS[col as keyof TableWidths];
        rows.push([pc.dim(`  ${col}`), v !== undefined ? String(v) : pc.dim("(not set)")]);
      }
    } else {
      const val = isReadonly(k) ? config[k as keyof Config] : KEY_DEFS[k]!.get(config);
      rows.push([pc.bold(k), val !== undefined ? String(val) : pc.dim("(not set)")]);
    }
  }
  const labelWidth = Math.max(...rows.map(([l]) => l.replace(/\x1b\[[0-9;]*m/g, "").length));
  for (const [label, val] of rows) {
    const plainLen = label.replace(/\x1b\[[0-9;]*m/g, "").length;
    console.log(`  ${label}${" ".repeat(labelWidth - plainLen + 2)}${val}`);
  }
  console.log();
}

// ---------------------------------------------------------------------------
// jira config set [key]
// ---------------------------------------------------------------------------

export async function setConfig(key?: string, value?: string): Promise<void> {
  if (!configExists()) {
    p.log.error("No config found. Run `jira config` to set up first.");
    process.exit(1);
  }
  const config = loadConfig();

  if (key) {
    if (isReadonly(key)) {
      p.log.error(`"${key}" is read-only (auto-set during config setup).`);
      process.exit(1);
    } else if (!KEY_DEFS[key]) {
      const valid = Object.keys(KEY_DEFS).join(", ");
      p.log.error(`Unknown settable key "${key}". Settable: ${valid}`);
      process.exit(1);
    } else {
      const def = KEY_DEFS[key];
      if (value !== undefined) {
        let parsed: unknown = value;
        try { parsed = JSON.parse(value); } catch { /* treat as plain string */ }
        def.set(config, parsed);
        saveConfig(config);
        p.log.success(`Set ${key} = ${typeof parsed === "object" ? JSON.stringify(parsed) : parsed}`);
      } else {
        if (isNamespace(key)) {
          p.intro(pc.bgCyan(pc.black(` jira config — ${key} `)));
        }
        const newValue = await promptForKey(key, config);
        if (p.isCancel(newValue)) { p.cancel("Cancelled."); process.exit(0); }
        def.set(config, newValue);
        saveConfig(config);
        if (!isNamespace(key)) {
          p.log.success(`Set ${key} = ${newValue}`);
        }
      }
    }
    return;
  }

  // No key → interactive menu
  p.intro(pc.bgCyan(pc.black(" jira config set ")));

  const options = Object.entries(KEY_DEFS)
    .filter(([k]) => !k.includes("."))
    .map(([k, def]) => {
      const v = def.get(config);
      return {
        value: k,
        label: def.label,
        hint: def.hint ?? (v != null ? (typeof v === "object" ? JSON.stringify(v) : String(v)) : "(not set)"),
      };
    });

  const selected = await p.select({ message: "Which setting would you like to change?", options });
  if (p.isCancel(selected)) { p.cancel("Cancelled."); process.exit(0); }

  const selKey = selected as string;
  const def = KEY_DEFS[selKey]!;
  if (isNamespace(selKey)) {
    p.intro(pc.bgCyan(pc.black(` jira config — ${selKey} `)));
  }
  const newValue = await promptForKey(selKey, config);
  if (p.isCancel(newValue)) { p.cancel("Cancelled."); process.exit(0); }
  def.set(config, newValue);
  saveConfig(config);
  if (!isNamespace(selKey)) {
    p.log.success(`Set ${selKey} = ${newValue}`);
  }
}

// ---------------------------------------------------------------------------
// jira config setup  (interactive full setup wizard)
// ---------------------------------------------------------------------------

const SETUP_SEQUENCE = ["baseUrl", "authType", "email", "jiraPat", "tempoPat"] as const;

export async function runConfig(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(" jira config ")));

  const draft: Partial<Config> = {};
  if (configExists()) {
    try { Object.assign(draft, loadConfig()); } catch { /* ignore */ }
  }

  for (const key of SETUP_SEQUENCE) {
    if (key === "email" && draft.authType !== "cloud") continue;
    const value = await promptForKey(key, draft as Config);
    if (p.isCancel(value)) { p.cancel("Cancelled."); process.exit(0); }
    KEY_DEFS[key]!.set(draft as Config, value);
  }

  const spinner = p.spinner();
  spinner.start("Verifying credentials…");

  let accountId: string;
  let displayName: string;
  try {
    const resolvedPat = resolvePat(draft.jiraPat!, "JIRA_PAT");
    const cleanBaseUrl = draft.baseUrl!.replace(/\/$/, "");
    const me = await getMyself(cleanBaseUrl, resolvedPat, draft.authType!, draft.email);
    accountId = me.accountId;
    displayName = me.displayName;
    spinner.stop(`Verified: ${pc.bold(displayName)}`);
  } catch (err) {
    spinner.stop("Verification failed");
    p.log.error(String(err));
    process.exit(1);
  }

  const config: Config = {
    ...(draft as Config),
    accountId,
    email: draft.authType === "cloud" ? draft.email : undefined,
  };

  saveConfig(config);
  p.outro(pc.green("✓ Config saved to ~/.config/jira-cli/config.json"));
}
