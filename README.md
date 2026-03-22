# jira-cli

> **⚠️ Vibe coded. I'm sorry I could not resist it 😅**

A personal CLI for Jira and Tempo. Pull issues to Markdown, edit locally, push changes back with 3-way merge conflict resolution, bulk-manage project issues, and log time via Tempo.

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
jira config setup
```

Interactive wizard that configures:

- **Base URL** — e.g. `https://yourcompany.atlassian.net`
- **Auth type** — Cloud (email + API token) or Data Center (PAT)
- **Email** — Cloud only
- **Jira PAT** — literal value or `$ENV_VAR` reference
- **Tempo PAT** — literal value or `$ENV_VAR` reference

Config is stored at `~/.config/jira-cli/config.json`.

### Viewing and editing config

```bash
jira config get              # Show all config values
jira config get baseUrl      # Show a specific value
jira config set              # Interactively set a value
jira config set baseUrl https://yourcompany.atlassian.net
```

#### Config keys

| Key | Notes |
|-----|-------|
| `baseUrl` | e.g. `https://yourcompany.atlassian.net` |
| `authType` | `cloud` or `datacenter` |
| `email` | Cloud only |
| `jiraPat` | Literal value or `$ENV_VAR` reference |
| `tempoPat` | Literal value or `$ENV_VAR` reference |
| `accountId` | Auto-set during setup; read-only |
| `tableWidths` | Column widths for issue tables (see below) |

#### PAT as environment variable

You can store token values as env var references instead of literal strings:

```json
{ "jiraPat": "$JIRA_PAT", "tempoPat": "$TEMPO_PAT" }
```

The CLI resolves these at runtime from the environment.

#### Table column widths

Customize the width of columns in issue tables:

```bash
jira config set tableWidths '{"key":10,"type":8,"status":14,"sprint":20,"estimate":8,"summary":60}'
```

---

## Commands

### Issues

```bash
jira issue describe <KEY>         # Print issue summary to terminal
jira issue pull <KEY> [file]      # Download issue as Markdown
jira issue push <KEY> [file]      # Push local changes back to Jira
jira issue set status <KEY>       # Transition issue status
jira issue comment <KEY>          # View comments and add new ones
```

#### `issue pull`

Downloads the issue as a Markdown file and saves a remote snapshot for conflict detection. The `[file]` argument is optional — if a working directory is configured for the project (see `project workdir`), the file is placed there automatically.

```bash
jira issue pull ABC-123
jira issue pull ABC-123 ./work/abc-123.md
jira issue pull ABC-123 --comments   # Include existing comments in the file
```

#### `issue push`

Diffs local vs snapshot vs remote. If your changes conflict with remote changes, each conflicting field is shown and you resolve them one at a time.

Supported fields: summary, status, assignee, priority, estimate, description.

```bash
jira issue push ABC-123
jira issue push ABC-123 ./work/abc-123.md
```

#### `issue set status`

Fetches available transitions for the issue and lets you pick one interactively, or pass it directly:

```bash
jira issue set status ABC-123
jira issue set status ABC-123 "In Progress"
```

#### `issue comment`

Shows existing comments and prompts you to add a new one. Supports `@@mention` syntax — type `@@name` and it resolves to the real Jira user.

```bash
jira issue comment ABC-123
```

#### Issue Markdown format

```markdown
# KEY - Summary

Type: Story
Status: In Progress
Assignee: user@company.com
Priority: High
Estimate: 3h
Sprint: Sprint 42 (2026-03-16 – 2026-03-29)
Reporter: reporter@company.com
Created: 2026-03-15

---

Description text here
```

---

### Projects

```bash
jira project workdir <KEY> [path]    # Set working directory for a project
jira project pull [project] [scope]  # Bulk pull issues
```

#### `project workdir`

Sets the local folder where pulled issues for a project are saved. Optionally creates `Current/` and `Done/` subfolders — issues are automatically moved between them when their status category changes.

```bash
jira project workdir ABC ~/notes/abc
jira project workdir ABC ~/notes/abc --status-folders   # Enable Current/Done subfolders
```

#### `project pull`

Bulk-pulls issues to local Markdown files. Issues that have not changed since their last snapshot are skipped.

```bash
jira project pull ABC sprint
jira project pull ABC backlog
jira project pull ABC all
jira project pull ABC "Sprint 42"     # Named sprint
```

**Filter options:**

| Option | Description |
|--------|-------------|
| `--from <date>` | Issues updated on or after this date |
| `--to <date>` | Issues updated on or before this date |
| `--fromKey <KEY>` | Issues with key ≥ this value |
| `--toKey <KEY>` | Issues with key ≤ this value |
| `--status <values>` | Comma-separated status filter (prefix `not:` to exclude) |
| `--type <values>` | Comma-separated issue type filter (prefix `not:` to exclude) |
| `--estimated <mode>` | `yes` / `no` / `parent` (subtasks with estimated parent) |
| `--name <text>` | Filter by summary (supports `"quoted phrases"`) |
| `--description <text>` | Filter by description text |
| `--pick` | Open interactive picker before pulling |

Examples:

```bash
jira project pull ABC sprint --status "In Progress,Review"
jira project pull ABC backlog --estimated no --type Story
jira project pull ABC all --status "not:Done" --from 2026-03-01
```

---

### Explore

Interactive TUI for browsing and acting on issues.

```bash
jira explore
jira explore ABC
jira explore ABC sprint
```

Walks you through picking a project, scope, and issue. On the selected issue you can: describe, add a comment, change status, or pull to a local file.

**Filter options** (same as `project pull`):

```bash
jira explore ABC sprint --status "In Progress"
jira explore ABC --type Bug --estimated yes
jira explore ABC --name "login flow"
```

**Non-interactive mode** — prints the issue table to stdout:

```bash
jira explore ABC sprint --no-interactive
```

---

### Tempo

```bash
jira tempo show [from] [to]    # Show logged hours
jira tempo log [from] [to]     # Log hours interactively or from file
```

#### Date expressions

Both commands accept flexible date arguments:

| Expression | Meaning |
|------------|---------|
| `today` | Today |
| `yesterday` | Yesterday |
| `week` | Start of current week |
| `last-week` | Start of last week |
| `month` | Start of current month |
| `last-month` | Start of last month |
| `year` | Start of current year |
| `YYYY-MM-DD` | Specific date |
| `-2-month` | 2 months ago |
| `3-week` | 3 weeks from now |
| `week-end` | End of current week |
| `month-end` | End of current month |

When a single argument is given, it's the start date and the end date defaults to today. For a range, pass two arguments.

```bash
jira tempo show month           # Start of month → today
jira tempo show month today     # Explicit range
jira tempo show 2026-03-01 2026-03-20
jira tempo log week
jira tempo log last-month month-end
```

#### `tempo show`

Displays logged time for the date range.

| Option | Description |
|--------|-------------|
| `--file <path>` | Export to a Markdown file |
| `--stdout` | Print Markdown to stdout |
| `--days <mode>` | `all` / `working` / `unlogged` (default) / `no-logs` |
| `--logged <duration>` | Threshold for "fully logged" day (default: `8h`) |
| `--short` | Compact single-line-per-day view |

```bash
jira tempo show month --short
jira tempo show month --file ~/tempo/march.md
jira tempo show week --days all
```

#### `tempo log`

Logs hours for the date range. Can be driven interactively, from a file, or via stdin.

| Option | Description |
|--------|-------------|
| `--file <path>` | Read entries from a Markdown file |
| `--stdin` | Read entries from stdin |
| `--days <mode>` | Same as `show` |
| `--logged <duration>` | Threshold for "fully logged" (default: `8h`) |
| `--skip-when <mode>` | `8h` — skip fully-logged days; `any` — skip days with any log |
| `--exact` | File day headers must exactly match the filtered working days |
| `--prompt` | Prompt for days that exist in the filter but are missing from the file |

```bash
jira tempo log month --file ~/tempo/march.md
jira tempo log week --stdin
jira tempo log month --skip-when 8h
jira tempo log week --prompt
```

#### Worklog file format

```markdown
# 2026-03-19
- ABC-123 Fixed the thing 2h
- XYZ-456 PR review 1h30m

# 2026-03-20
- ABC-124 More fixes 3h
```

Entry format: `KEY description duration` (leading `- ` is optional).
Duration formats: `2h`, `30m`, `1h30m`, `1.5h`.

When logging from a file, the date range is inferred from the section headers — no need to specify dates separately. Worklogs are created sequentially starting at 09:00; each entry starts where the previous one ends.

---

## Data stored locally

| Path | Purpose |
|------|---------|
| `~/.config/jira-cli/config.json` | Credentials and settings |
| `~/.config/jira-cli/active.json` | Issue key → local file path mapping |
| `~/.config/jira-cli/projects.json` | Per-project working dirs and status folder config |
| `~/.config/jira-cli/remote/<KEY>.md` | Remote snapshots used for 3-way merge |
