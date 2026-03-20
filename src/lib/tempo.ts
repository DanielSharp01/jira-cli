import type { Config } from "./types.ts";
import type { TempoWorklog } from "./types.ts";
import { getTempoPat } from "./config.ts";

function getWeekdaysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  const cur = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  while (cur <= end) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) {
      days.push(cur.toISOString().slice(0, 10));
    }
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

const TEMPO_BASE = "https://api.tempo.io/4";

async function req<T>(
  config: Config,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const pat = getTempoPat(config);
  const url = `${TEMPO_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${pat}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Tempo ${method} ${path} → ${res.status}: ${text}`);
  }
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

interface TempoListResponse {
  results: TempoWorklog[];
  metadata: { count: number; limit: number; offset: number; next?: string };
}

async function searchWorklogs(config: Config, from: string, to: string): Promise<TempoWorklog[]> {
  const pat = getTempoPat(config);
  const headers = {
    Authorization: `Bearer ${pat}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const all: TempoWorklog[] = [];
  let offset = 0;

  while (true) {
    const res = await fetch(`${TEMPO_BASE}/worklogs/search?limit=50&offset=${offset}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ authorIds: [config.accountId], from, to }),
    });
    const data = await res.json() as TempoListResponse;
    const results = data.results ?? [];
    if (results.length === 0) break;
    all.push(...results);
    offset += results.length;
  }

  return all;
}

export async function getWorklogs(config: Config, date: string): Promise<TempoWorklog[]> {
  return searchWorklogs(config, date, date);
}

export async function deleteWorklog(config: Config, id: number): Promise<void> {
  await req<void>(config, "DELETE", `/worklogs/${id}`);
}

export async function getWorklogsForRange(config: Config, from: string, to: string): Promise<TempoWorklog[]> {
  return searchWorklogs(config, from, to);
}

interface TempoScheduleDay {
  date: string;
  requiredSeconds: number;
}

export async function getWorkingDays(config: Config, from: string, to: string): Promise<string[]> {
  try {
    const res = await req<{ results: TempoScheduleDay[] }>(
      config, "GET",
      `/user-schedule?accountId=${config.accountId}&from=${from}&to=${to}`
    );
    return res.results
      .filter(d => d.requiredSeconds > 0)
      .map(d => d.date)
      .sort();
  } catch {
    return getWeekdaysBetween(from, to);
  }
}

export async function createWorklog(
  config: Config,
  opts: {
    issueId: number;
    timeSpentSeconds: number;
    startDate: string;
    startTime: string;
    description: string;
  }
): Promise<TempoWorklog> {
  return req<TempoWorklog>(config, "POST", "/worklogs", {
    issueId: opts.issueId,
    timeSpentSeconds: opts.timeSpentSeconds,
    startDate: opts.startDate,
    startTime: opts.startTime,
    description: opts.description,
    authorAccountId: config.accountId,
  });
}
