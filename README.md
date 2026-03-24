# jira-cli

A CLI + Web UI for Jira and Tempo with AI-powered worklog suggestions. Pull issues to Markdown, edit locally, push changes back with 3-way merge conflict resolution, bulk-manage project issues, and log time via Tempo — with an AI assistant that generates worklog suggestions from git activity, Jira transitions, Google Calendar, Google Chat, and historical patterns.

Built with Bun, Commander.js, @clack/prompts, LangChain, and Tailwind CSS.

---

## Quickstart

```bash
# 1. Clone and install
git clone <repo-url> && cd jira-cli
bun install

# 2. Copy .env.example and fill in your credentials
cp .env.example .env
# Edit .env with your JIRA_PAT, TEMPO_PAT, OPENAI_API_KEY

# 3. Run interactive setup (configures Jira connection)
bun run start config setup

# 4. Open the timesheet UI
bun run start tempo ui

# 5. (Optional) Install as global command
bun link
jira tempo ui
```

## Requirements

- [Bun](https://bun.sh) (v1.0+)
- A Jira Cloud or Data Center instance
- A Tempo account (for time tracking)
- An OpenAI API key (for AI suggestions)
- Google Workspace account (optional, for Calendar + Chat integration)

## Installation

```bash
bun install
```

Run directly:

```bash
bun run start <command>
```

Or install globally:

```bash
bun link
jira <command>
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

### Environment variables

Add to `.env` (Bun auto-loads it):

```bash
JIRA_PAT=your-jira-api-token
TEMPO_PAT=your-tempo-pat
OPENAI_API_KEY=your-openai-key

# Optional: Google Workspace integration
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

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
| `tableWidths` | Column widths for issue tables |
| `scanDirs` | Parent directories to scan for git repos |
| `googleClientId` | Google OAuth Client ID |
| `googleClientSecret` | Google OAuth Client Secret |

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

---

### Projects

```bash
jira project workdir <KEY> [path]    # Set working directory for a project
jira project pull [project] [scope]  # Bulk pull issues
```

#### `project workdir`

Sets the local folder where pulled issues for a project are saved. Optionally creates `Current/` and `Done/` subfolders.

```bash
jira project workdir ABC ~/notes/abc
jira project workdir ABC ~/notes/abc --status-folders
```

#### `project pull`

Bulk-pulls issues to local Markdown files. Issues that have not changed since their last snapshot are skipped.

```bash
jira project pull ABC sprint
jira project pull ABC backlog
jira project pull ABC all
jira project pull ABC "Sprint 42"
```

**Filter options:**

| Option | Description |
|--------|-------------|
| `--from <date>` | Issues updated on or after this date |
| `--to <date>` | Issues updated on or before this date |
| `--status <values>` | Comma-separated status filter (prefix `not:` to exclude) |
| `--type <values>` | Comma-separated issue type filter |
| `--estimated <mode>` | `yes` / `no` / `parent` |
| `--name <text>` | Filter by summary (supports `"quoted phrases"`) |
| `--pick` | Open interactive picker before pulling |

---

### Explore

Interactive TUI for browsing and acting on issues.

```bash
jira explore
jira explore ABC
jira explore ABC sprint
```

Supports the same filter options as `project pull`.

---

### Tempo

```bash
jira tempo show [from] [to]       # Show logged hours
jira tempo log [from] [to]        # Log hours interactively or from file
jira tempo suggest [from] [to]    # AI-powered worklog suggestions (CLI)
jira tempo ui [from] [to]         # Open web-based timesheet UI
```

#### Date expressions

All tempo commands accept flexible date arguments:

| Expression | Meaning |
|------------|---------|
| `today` | Today |
| `yesterday` | Yesterday |
| `week` / `last-week` | Start of current/last week |
| `month` / `last-month` | Start of current/last month |
| `year` | Start of current year |
| `YYYY-MM-DD` | Specific date |
| `-2-month` | 2 months ago |
| `week-end` / `month-end` | End of period |

#### `tempo show`

Displays logged time for the date range.

```bash
jira tempo show month --short
jira tempo show week --days unlogged
jira tempo show month --file ~/tempo/march.md
```

#### `tempo log`

Logs hours interactively, from a file, or via stdin.

```bash
jira tempo log week
jira tempo log month --file ~/tempo/march.md
```

**Worklog file format:**

```markdown
# 2026-03-19
- ABC-123 Fixed the thing 2h
- XYZ-456 PR review 1h30m

# 2026-03-20
- ABC-124 More fixes 3h
```

#### `tempo suggest`

AI-powered worklog suggestions from multiple evidence sources.

```bash
jira tempo suggest week              # Suggest for current week
jira tempo suggest month --dry-run   # Preview without submitting
jira tempo suggest week --no-git     # Skip git scanning
```

| Option | Description |
|--------|-------------|
| `--repo <paths...>` | Additional git repos to scan |
| `--no-git` | Skip git scanning |
| `--hours <duration>` | Target hours per day (default: `8h`) |
| `--model <name>` | Override LLM model |
| `--dry-run` | Show suggestions without submitting |

**Evidence sources:**

| Source | What it provides |
|--------|-----------------|
| Git commits | Commit messages, branch names, changed files, work type |
| Uncommitted changes | Work in progress (modified/staged files) |
| Jira status transitions | Issues the user moved between statuses |
| Sprint issues | Issues assigned to the user in active sprints |
| User comments | Issues the user commented on |
| Historical worklogs | 3-month lookback with recurring pattern detection (daily/weekly cadence) |
| Google Calendar | Meeting events with attendees and durations |
| Google Chat | Channel message activity |

The AI uses all available evidence to generate plausible worklog entries, matching the user's preferred description style (learned from past worklogs stored in SQLite).

#### `tempo ui`

Opens a local web UI with a Tempo-like timesheet grid.

```bash
jira tempo ui                    # Current week
jira tempo ui month              # Current month
jira tempo ui --port 3000        # Specific port
jira tempo ui --no-open          # Don't auto-open browser
```

| Option | Description |
|--------|-------------|
| `--port <number>` | Server port (default: random) |
| `--repo <paths...>` | Additional git repos to scan |
| `--hours <duration>` | Target hours per day (default: `8h`) |
| `--no-open` | Don't open browser automatically |

**Web UI features:**

- **Timesheet grid** — Issue rows x day columns with logged hours per cell
- **Week/Month view** — Toggle between week (detailed) and month (compact) layouts
- **Dark mode** — Toggle with persistent preference
- **Inline editing** — Click any cell to edit duration + description
- **Draft mode** — Edits and accepted suggestions become drafts (green). Nothing submits until you click "Submit All"
- **AI suggestions** — Click "Generate" to fill empty cells with AI-powered suggestions (blue). Natural language instructions supported (e.g., "Fill March with my usual pattern. I was on vacation 17-18")
- **Accept All / per-cell** — Accept all suggestions at once or individually
- **Real-time SSE progress** — See each evidence gathering phase as it runs
- **Copy Previous Week** — Duplicate last week's worklogs as drafts
- **Issue search** — Add new issue rows with autocomplete from Jira
- **Issue titles** — Issue summaries shown below keys in the grid
- **Keyboard navigation** — Arrow keys, Enter to edit, `a` to accept, `x` to reject, `d` to delete
- **CSV export** — Download current grid data as CSV
- **Settings panel** — Manage scan directories, Google Workspace connection, and learned description preferences

---

## Google Workspace Integration

Connect Google Calendar and Chat to improve AI suggestions with meeting and communication data.

### Setup

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create or select a project
3. Enable **Google Calendar API** and **Google Chat API**
4. Go to **OAuth consent screen** → choose **Internal** (for Workspace)
5. Go to **Credentials** → **Create Credentials** → **OAuth client ID** → type **Desktop app**
6. Add the Client ID and Secret to `.env`:

```bash
GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
```

7. Open the web UI (`jira tempo ui`) → Settings (gear icon) → Click **Connect** under Google Workspace
8. Authorize with your company Google account

Once connected, calendar events and chat activity are automatically included in AI suggestion evidence.

---

## Data stored locally

| Path | Purpose |
|------|---------|
| `~/.config/jira-cli/config.json` | Credentials and settings |
| `~/.config/jira-cli/active.json` | Issue key → local file path mapping |
| `~/.config/jira-cli/projects.json` | Per-project working dirs and status folder config |
| `~/.config/jira-cli/remote/<KEY>.md` | Remote snapshots used for 3-way merge |
| `~/.config/jira-cli/jira-cli.db` | SQLite database (learned descriptions, OAuth tokens) |

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| "No config found" | Run `jira config setup` to create initial configuration |
| "OPENAI_API_KEY is not set" | Add `OPENAI_API_KEY=sk-...` to your `.env` file |
| "Could not resolve issue: PROJ-123" | Check the issue key exists in Jira and your account has access |
| "Google token expired or revoked" | Open UI → Settings → Click "Connect" to re-authorize |
| "googleClientId not configured" | Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to `.env` |
| Port already in use | Use `--port <number>` to specify a different port: `jira tempo ui --port 3001` |
| AI suggestions use wrong model | Set `OPENAI_MODEL=gpt-4o` in `.env` to override (default: `gpt-4o-mini`) |
| Database errors | Delete `~/.config/jira-cli/jira-cli.db` — it will be recreated automatically |
