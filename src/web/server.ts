import type { Config, JiraIssue } from "../lib/types.ts";
import { getWorklogsForRange, getWorkingDays, createWorklog, deleteWorklog } from "../lib/tempo.ts";
import { getIssueKeysByIds, getIssueIdsByKeys, searchIssues, getIssue, getTransitions, applyTransition, addComment } from "../lib/jira.ts";
import type { AdfDoc } from "../lib/types.ts";
import { gatherAllEvidence, gatherHistoricalPatterns, discoverGitRepos } from "../lib/evidence.ts";
import { generateSuggestions } from "../lib/suggest.ts";
import { trackDescription, getAllPreferredDescriptions, deleteDescriptionPref, clearAllDescriptionPrefs, trackSuggestionFeedback, getScanDirs, addScanDirDb, removeScanDirDb, toggleScanDirDb, migrateScanDirsToDb } from "../lib/db.ts";
import type { SuggestionFeedbackEntry } from "../lib/db.ts";
import { buildGoogleAuthUrl, exchangeGoogleCode, isGoogleConnected } from "../lib/google.ts";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";

interface ServerOpts {
  config: Config;
  defaultFrom: string;
  defaultTo: string;
  repoPaths: string[];
  targetSecondsPerDay: number;
  port: number;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(err: unknown, status = 500): Response {
  return jsonResponse({ error: String(err) }, status);
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function startServer(opts: ServerOpts): { port: number } {
  const { config, defaultFrom, defaultTo, repoPaths, targetSecondsPerDay } = opts;

  // Migrate scan dirs from config.json to database (one-time)
  try {
    if (config.scanDirs && config.scanDirs.length > 0 && getScanDirs().length === 0) {
      migrateScanDirsToDb(config.scanDirs);
    }
  } catch { /* migration is best-effort */ }

  // Helper to get fresh repo paths from DB scan dirs
  async function getFreshRepoPaths(): Promise<string[]> {
    try {
      const dbDirs = getScanDirs();
      const enabledDirs = dbDirs.filter(d => d.enabled).map(d => d.path);
      return enabledDirs.length > 0 ? await discoverGitRepos([], enabledDirs) : repoPaths;
    } catch {
      return repoPaths;
    }
  }

  // Track the actual port after server starts (avoids circular ref accessing server.port inside fetch)
  let actualPort = opts.port;

  const server = Bun.serve({
    port: opts.port,
    idleTimeout: 255, // max allowed — AI generation + bulk operations can take a while

    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // Serve HTML
      if (path === "/" && req.method === "GET") {
        try {
          const htmlPath = `${import.meta.dir}/index.html`;
          let html = await Bun.file(htmlPath).text();
          const dbScanDirs = (() => { try { return getScanDirs(); } catch { return config.scanDirs ?? []; } })();
          html = html.replace(
            "/*__SERVER_CONFIG__*/",
            `window.__CONFIG__ = ${JSON.stringify({ from: defaultFrom, to: defaultTo, targetSecondsPerDay, scanDirs: dbScanDirs })};`
          );
          return new Response(html, { headers: { "Content-Type": "text/html" } });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/worklogs?from=&to=
      if (path === "/api/worklogs" && req.method === "GET") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return errorResponse("Missing from/to params", 400);

        try {
          const worklogs = await getWorklogsForRange(config, from, to);
          const issueIds = [...new Set(worklogs.map(w => w.issue.id))];
          const keyMap = await getIssueKeysByIds(config, issueIds);

          // Fetch issue summaries
          const uniqueKeys = [...new Set([...keyMap.values()])];
          const summaryMap = new Map<string, string>();
          if (uniqueKeys.length > 0) {
            try {
              const quoted = uniqueKeys.map(k => `"${k}"`).join(",");
              const issues = await searchIssues(config, `key in (${quoted})`, uniqueKeys.length);
              for (const i of issues) summaryMap.set(i.key, i.fields.summary);
            } catch { /* summaries are optional */ }
          }

          const enriched = worklogs.map(w => {
            const issueKey = keyMap.get(w.issue.id) ?? String(w.issue.id);
            return {
              tempoWorklogId: w.tempoWorklogId,
              issueKey,
              issueId: w.issue.id,
              timeSpentSeconds: w.timeSpentSeconds,
              startDate: w.startDate,
              startTime: w.startTime,
              description: w.description,
              issueSummary: summaryMap.get(issueKey) ?? "",
            };
          });

          return jsonResponse({ worklogs: enriched });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/working-days?from=&to=
      if (path === "/api/working-days" && req.method === "GET") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        if (!from || !to) return errorResponse("Missing from/to params", 400);

        try {
          const workingDays = await getWorkingDays(config, from, to);
          return jsonResponse({ workingDays, targetSecondsPerDay });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/issues?q=
      if (path === "/api/issues" && req.method === "GET") {
        const q = url.searchParams.get("q")?.trim();
        if (!q || q.length < 2) return jsonResponse({ issues: [] });

        const fmt = (i: JiraIssue) => ({ key: i.key, id: i.id, summary: i.fields.summary });

        const upper = q.toUpperCase();
        const escaped = q.replace(/"/g, '\\"');
        const MAX = 30;

        // Build parallel JQL queries
        const queries: string[] = [];

        if (/^[A-Z][A-Z0-9]+-\d+$/.test(upper)) {
          queries.push(`key = "${upper}"`);
        }

        if (/^[A-Z][A-Z0-9]+-\d+/.test(upper)) {
          const prefix = upper.match(/^([A-Z][A-Z0-9]+-\d+)/)![1]!;
          queries.push(`key >= "${prefix}" AND key <= "${prefix}999" ORDER BY key ASC`);
        }

        if (/^[A-Z][A-Z0-9]+-?$/.test(upper)) {
          const proj = upper.replace(/-$/, "");
          // User's own issues in project first, then all project issues
          queries.push(`project = "${proj}" AND assignee = currentUser() ORDER BY updated DESC`);
          queries.push(`project = "${proj}" ORDER BY updated DESC`);
        }

        // Text search across summary, description, comments
        queries.push(`text ~ "${escaped}" ORDER BY updated DESC`);

        if (q.length >= 3) {
          queries.push(`summary ~ "${escaped}*" ORDER BY updated DESC`);
        }

        // Run all queries in parallel, merge and deduplicate
        const dedupe = new Set<string>();
        const results: Array<{ key: string; id: string; summary: string }> = [];

        const settled = await Promise.allSettled(
          [...new Set(queries)].map(jql => searchIssues(config, jql, MAX).catch(() => [] as JiraIssue[]))
        );

        for (const outcome of settled) {
          if (outcome.status !== "fulfilled") continue;
          for (const issue of outcome.value) {
            if (!dedupe.has(issue.key)) {
              dedupe.add(issue.key);
              results.push(fmt(issue));
              if (results.length >= MAX) break;
            }
          }
          if (results.length >= MAX) break;
        }

        return jsonResponse({ issues: results });
      }

      // GET /api/issues/initial?from=&to=
      if (path === "/api/issues/initial" && req.method === "GET") {
        const from = url.searchParams.get("from");
        const to = url.searchParams.get("to");
        try {
          const [sprintIssues, recentIssues] = await Promise.all([
            searchIssues(config, `assignee = currentUser() AND sprint in openSprints() ORDER BY updated DESC`, 50).catch(() => [] as JiraIssue[]),
            from && to
              ? searchIssues(config, `assignee = currentUser() AND status changed DURING ("${from}", "${to}") ORDER BY updated DESC`, 30).catch(() => [] as JiraIssue[])
              : Promise.resolve([] as JiraIssue[]),
          ]);

          const fmt = (i: JiraIssue) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name ?? "" });
          const sprint = sprintIssues.map(fmt);
          const sprintKeys = new Set(sprint.map(i => i.key));
          const recent = recentIssues.filter(i => !sprintKeys.has(i.key)).map(fmt);

          return jsonResponse({ sprint, recent });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/worklog
      if (path === "/api/worklog" && req.method === "POST") {
        try {
          const body = await req.json() as {
            issueKey: string;
            timeSpentSeconds: number;
            startDate: string;
            startTime: string;
            description: string;
          };

          const idMap = await getIssueIdsByKeys(config, [body.issueKey]);
          const issueId = idMap.get(body.issueKey);
          if (!issueId) return errorResponse(`Could not resolve issue: ${body.issueKey}`, 400);

          const worklog = await createWorklog(config, {
            issueId,
            timeSpentSeconds: body.timeSpentSeconds,
            startDate: body.startDate,
            startTime: body.startTime,
            description: body.description,
          });

          try { trackDescription(body.issueKey, body.description); } catch { /* db is optional */ }

          return jsonResponse({
            tempoWorklogId: worklog.tempoWorklogId,
            issueKey: body.issueKey,
            issueId,
            timeSpentSeconds: worklog.timeSpentSeconds,
            startDate: worklog.startDate,
            startTime: worklog.startTime,
            description: worklog.description,
          });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // DELETE /api/worklog/:id
      if (path.startsWith("/api/worklog/") && req.method === "DELETE") {
        const id = parseInt(path.split("/")[3] ?? "", 10);
        if (isNaN(id)) return errorResponse("Invalid worklog ID", 400);

        try {
          await deleteWorklog(config, id);
          return jsonResponse({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/worklogs/batch
      if (path === "/api/worklogs/batch" && req.method === "POST") {
        try {
          const body = await req.json() as {
            create: Array<{ issueKey: string; timeSpentSeconds: number; startDate: string; startTime: string; description: string }>;
            delete: number[];
          };

          // Validate all issue keys BEFORE any deletes (prevent data loss on partial failure)
          const allKeys = [...new Set(body.create.map(c => c.issueKey))];
          const idMap = allKeys.length > 0 ? await getIssueIdsByKeys(config, allKeys) : new Map<string, number>();
          const unresolved = allKeys.filter(k => !idMap.get(k));
          if (unresolved.length > 0) return errorResponse(`Could not resolve issues: ${unresolved.join(", ")}`, 400);

          // Delete (only after validation passes)
          const deleted: number[] = [];
          const deleteFailed: Array<{ id: number; error: string }> = [];
          for (const id of body.delete) {
            try { await deleteWorklog(config, id); deleted.push(id); }
            catch (err) { deleteFailed.push({ id, error: String(err) }); }
          }

          // Create
          const created: Array<{ tempoWorklogId: number; issueKey: string }> = [];
          const createFailed: Array<{ issueKey: string; error: string }> = [];
          for (const entry of body.create) {
            try {
              const issueId = idMap.get(entry.issueKey)!;
              const wl = await createWorklog(config, {
                issueId,
                timeSpentSeconds: entry.timeSpentSeconds,
                startDate: entry.startDate,
                startTime: entry.startTime,
                description: entry.description,
              });
              created.push({ tempoWorklogId: wl.tempoWorklogId, issueKey: entry.issueKey });
              try { trackDescription(entry.issueKey, entry.description); } catch { /* db is optional */ }
            } catch (err) {
              createFailed.push({ issueKey: entry.issueKey, error: String(err) });
            }
          }

          const hasFailures = deleteFailed.length > 0 || createFailed.length > 0;
          return jsonResponse({
            deleted: deleted.length,
            created: created.length,
            ...(hasFailures ? { deleteFailed, createFailed } : {}),
          }, hasFailures ? 207 : 200);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/preferences
      if (path === "/api/preferences" && req.method === "GET") {
        try {
          const prefs = getAllPreferredDescriptions(100);
          return jsonResponse({ preferences: prefs });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // DELETE /api/preferences
      if (path === "/api/preferences" && req.method === "DELETE") {
        try {
          const body = await req.json() as { issueKey?: string; description?: string };
          if (body.issueKey && body.description) {
            deleteDescriptionPref(body.issueKey, body.description);
          } else {
            clearAllDescriptionPrefs();
          }
          return jsonResponse({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/patterns?from=
      if (path === "/api/patterns" && req.method === "GET") {
        const from = url.searchParams.get("from");
        if (!from) return errorResponse("Missing from param", 400);

        try {
          const patterns = await gatherHistoricalPatterns(config, from);
          return jsonResponse({ patterns: patterns.recurringPatterns });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/suggest (kept for backwards compat)
      if (path === "/api/suggest" && req.method === "POST") {
        try {
          const body = await req.json() as {
            from: string;
            to: string;
            targetHoursPerDay?: number;
            model?: string;
            instructions?: string;
          };

          const targetHours = body.targetHoursPerDay ?? targetSecondsPerDay / 3600;
          const freshPaths = await getFreshRepoPaths();
          const evidence = await gatherAllEvidence(config, freshPaths, body.from, body.to);
          const suggestions = await generateSuggestions(evidence, targetHours, body.model, body.instructions);

          return jsonResponse(suggestions);
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/suggest-stream (SSE with progress updates)
      if (path === "/api/suggest-stream" && req.method === "POST") {
        let body: { from: string; to: string; targetHoursPerDay?: number; model?: string; instructions?: string };
        try {
          body = await req.json() as typeof body;
        } catch {
          return errorResponse("Invalid JSON body", 400);
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const send = (event: string, data: unknown) => {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            };

            try {
              const targetHours = body.targetHoursPerDay ?? targetSecondsPerDay / 3600;
              const freshPaths = await getFreshRepoPaths();

              const evidence = await gatherAllEvidence(
                config, freshPaths, body.from, body.to,
                (phase, message) => send("progress", { phase, message }),
              );

              // Send evidence summary
              const evidenceSummary = {
                commits: evidence.git.reduce((n, r) => n + r.commits.length, 0),
                repos: evidence.git.length,
                transitions: evidence.jiraActivity.statusTransitions.length,
                sprintIssues: evidence.jiraActivity.sprintIssues.length,
                patterns: evidence.historicalPatterns.recurringPatterns.length,
                comments: evidence.jiraActivity.commentedIssues.length,
              };
              send("evidence", evidenceSummary);

              send("progress", { phase: "llm", message: "Generating suggestions with AI..." });
              const suggestions = await generateSuggestions(evidence, targetHours, body.model, body.instructions);

              send("result", suggestions);
            } catch (err) {
              send("error", { error: String(err) });
            }

            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      }

      // GET /api/issue/:key
      if (path.match(/^\/api\/issue\/[A-Z][A-Z0-9]+-\d+$/) && req.method === "GET") {
        const key = path.split("/")[3]!;
        try {
          const issue = await getIssue(config, key, true);
          const sprint = issue.fields.customfield_10020;
          const sprintName = Array.isArray(sprint) && sprint.length > 0 ? sprint[sprint.length - 1]?.name : null;
          return jsonResponse({
            key: issue.key,
            summary: issue.fields.summary,
            status: issue.fields.status.name,
            type: issue.fields.issuetype.name,
            assignee: issue.fields.assignee?.displayName ?? null,
            reporter: issue.fields.reporter?.displayName ?? null,
            priority: issue.fields.priority?.name ?? null,
            sprint: sprintName,
            estimate: issue.fields.timetracking?.originalEstimate ?? null,
            created: issue.fields.created?.slice(0, 10),
            updated: issue.fields.updated?.slice(0, 10),
            description: issue.fields.description,
            comments: (issue.fields.comment?.comments ?? []).slice(-10).map(c => ({
              author: c.author.displayName,
              created: c.created.slice(0, 10),
              body: c.body,
            })),
          });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/issue/:key/transitions
      if (path.match(/^\/api\/issue\/[A-Z][A-Z0-9]+-\d+\/transitions$/) && req.method === "GET") {
        const key = path.split("/")[3]!;
        try {
          const transitions = await getTransitions(config, key);
          return jsonResponse({ transitions: transitions.map(t => ({ id: t.id, name: t.name })) });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/issue/:key/transition
      if (path.match(/^\/api\/issue\/[A-Z][A-Z0-9]+-\d+\/transition$/) && req.method === "POST") {
        const key = path.split("/")[3]!;
        try {
          const body = await req.json() as { transitionId: string };
          await applyTransition(config, key, body.transitionId);
          return jsonResponse({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/issue/:key/comment
      if (path.match(/^\/api\/issue\/[A-Z][A-Z0-9]+-\d+\/comment$/) && req.method === "POST") {
        const key = path.split("/")[3]!;
        try {
          const body = await req.json() as { text: string };
          const adfBody: AdfDoc = {
            version: 1,
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: body.text }] }],
          };
          await addComment(config, key, adfBody);
          return jsonResponse({ ok: true });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/scan-dirs
      if (path === "/api/scan-dirs" && req.method === "GET") {
        try {
          return jsonResponse({ scanDirs: getScanDirs() });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // POST /api/scan-dirs — add a directory
      if (path === "/api/scan-dirs" && req.method === "POST") {
        try {
          const body = await req.json() as { path: string };
          addScanDirDb(body.path);
          return jsonResponse({ ok: true, scanDirs: getScanDirs() });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // DELETE /api/scan-dirs — remove a directory
      if (path === "/api/scan-dirs" && req.method === "DELETE") {
        try {
          const body = await req.json() as { path: string };
          removeScanDirDb(body.path);
          return jsonResponse({ ok: true, scanDirs: getScanDirs() });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // PATCH /api/scan-dirs — toggle enabled
      if (path === "/api/scan-dirs" && req.method === "PATCH") {
        try {
          const body = await req.json() as { path: string; enabled: boolean };
          toggleScanDirDb(body.path, body.enabled);
          return jsonResponse({ ok: true, scanDirs: getScanDirs() });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/browse-dirs — list subdirectories for file browser
      if (path === "/api/browse-dirs" && req.method === "GET") {
        try {
          const requestedPath = url.searchParams.get("path") || homedir();
          const resolved = resolve(requestedPath);
          const entries = readdirSync(resolved, { withFileTypes: true });
          const dirs = entries
            .filter(e => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
            .map(e => e.name)
            .sort((a, b) => a.localeCompare(b));
          return jsonResponse({ current: resolved, parent: dirname(resolved), dirs });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /api/google/status
      if (path === "/api/google/status" && req.method === "GET") {
        const hasClientId = !!(config.googleClientId || process.env.GOOGLE_CLIENT_ID);
        const hasClientSecret = !!(config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET);
        return jsonResponse({
          connected: isGoogleConnected(),
          configured: hasClientId && hasClientSecret,
        });
      }

      // GET /api/google/connect
      if (path === "/api/google/connect" && req.method === "GET") {
        try {
          const redirectUri = `http://localhost:${actualPort}/oauth/google/callback`;
          const authUrl = buildGoogleAuthUrl(config, redirectUri);
          return jsonResponse({ authUrl });
        } catch (err) {
          return errorResponse(err);
        }
      }

      // GET /oauth/google/callback
      if (path === "/oauth/google/callback" && req.method === "GET") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");

        if (error) {
          return new Response(`<html><body><h2>Authorization failed</h2><p>${escHtml(error)}</p><p>You can close this tab.</p></body></html>`, {
            headers: { "Content-Type": "text/html" },
          });
        }

        if (!code) {
          return new Response("<html><body><h2>Missing authorization code</h2></body></html>", {
            status: 400,
            headers: { "Content-Type": "text/html" },
          });
        }

        try {
          const redirectUri = `http://localhost:${actualPort}/oauth/google/callback`;
          await exchangeGoogleCode(config, code, redirectUri);
          return new Response(`<html><body><h2>Google Workspace connected!</h2><p>You can close this tab and return to the Tempo UI.</p><script>window.close()</script></body></html>`, {
            headers: { "Content-Type": "text/html" },
          });
        } catch (err) {
          return new Response(`<html><body><h2>Authorization failed</h2><p>${escHtml(String(err))}</p></body></html>`, {
            status: 500,
            headers: { "Content-Type": "text/html" },
          });
        }
      }

      // POST /api/suggest-feedback
      if (path === "/api/suggest-feedback" && req.method === "POST") {
        try {
          const body = await req.json() as { entries: SuggestionFeedbackEntry[] };
          for (const entry of body.entries) {
            trackSuggestionFeedback(entry);
          }
          return jsonResponse({ ok: true, tracked: body.entries.length });
        } catch (err) {
          return errorResponse(err);
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  actualPort = server.port ?? opts.port;
  return { port: actualPort };
}
