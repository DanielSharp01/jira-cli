# jira-cli

> **⚠️ Vibe coded. Not human reviewed. Use at your own risk.**

A personal CLI for Jira and Tempo. Lets you pull issues to Markdown, edit them locally, push changes back with conflict resolution, and log time via Tempo.

Built with Bun, Commander.js, and @clack/prompts.

---

## Requirements

- [Bun](https://bun.sh)
- A Jira Cloud or Data Center instance
- A Tempo account (for time tracking)

## Installation

```bash
bun install
```

Run directly:

```bash
bun run src/index.ts <command>
```

Or use the `dev` script:

```bash
bun run dev <command>
```

---

## Setup

```bash
jira config
```

Walks you through:
- **Base URL** — e.g. `https://yourcompany.atlassian.net`
- **Auth type** — Cloud (email + API token) or Data Center (PAT)
- **Email** — Cloud only
- **Jira PAT** — literal value or `$ENV_VAR` reference
- **Tempo PAT** — literal value or `$ENV_VAR` reference

Config is stored at `~/.config/jira-cli/config.json`.

---

## Commands

### Issues

```bash
jira issue describe <KEY>          # Print issue summary to terminal
jira issue pull <KEY> [file]       # Download issue to a Markdown file
jira issue push <KEY> [file]       # Push local changes back to Jira (3-way merge)
jira issue set status <KEY>        # Transition issue status
jira issue comment <KEY>           # View/add comments (@@mention support)
```

Pull downloads the issue as Markdown and saves a snapshot. Push diffs local vs snapshot vs remote — if there are conflicts, it asks you to resolve them field by field.

### Projects

```bash
jira project workdir <KEY> <path>  # Set working directory for a project
jira project pull <KEY> [scope]    # Bulk pull issues (scope: sprint | backlog | all)
```

Options for `pull`:
- `--from <YYYY-MM-DD>` — only issues updated since this date
- `--status <statuses>` — comma-separated status filter

### Explorer

```bash
jira explore [project] [scope]
```

Interactive TUI: pick a project → scope → issue. Then describe, comment, set status, or pull.

### Tempo

```bash
jira tempo show [from] [to]        # Show logged hours
jira tempo log [from] [to]         # Log hours interactively
```

**Date arguments**: `YYYY-MM-DD`, `today`, `week`, `month`, or two dates for a range.

Examples:
```bash
jira tempo show month
jira tempo show month today        # Start of month → today
jira tempo log week
jira tempo log 2026-03-01 2026-03-20
```

#### File-based logging

```bash
jira tempo show month today --file tempo.md   # Export to file
jira tempo log --file tempo.md                # Log from file (dates inferred from file)
```

The Markdown format used by both commands:

```markdown
# 2026-03-19
- ABC-123 Fixed the thing 2h
- XYZ-456 PR review 1h30m

# 2026-03-20
- ABC-124 More fixes 3h
```

Entry format: `KEY description duration` (leading `- ` optional).
Duration formats: `2h`, `30m`, `1h30m`, `1.5h`.

When logging from a file, the date range is inferred from the section headers — no need to specify dates. Days with existing Tempo logs will show a confirmation before overwriting. Worklogs are created sequentially starting at 09:00, each one starting where the previous ends.

`--skip-when` option:
- `8h` — skip days that already have 8h logged
- `any` — skip days with any existing logs

---

## Data stored locally

| Path | Purpose |
|------|---------|
| `~/.config/jira-cli/config.json` | Credentials and settings |
| `~/.config/jira-cli/active.json` | Issue key → local file path mapping |
| `~/.config/jira-cli/projects.json` | Per-project working dirs |
| `~/.config/jira-cli/remote/<KEY>.md` | Snapshots for 3-way merge |
