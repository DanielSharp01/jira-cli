import type { Config } from "./types.ts";
import { saveOAuthTokens, getOAuthTokens } from "./db.ts";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/chat.messages.readonly",
  "https://www.googleapis.com/auth/chat.spaces.readonly",
].join(" ");

// ---------------------------------------------------------------------------
// OAuth2
// ---------------------------------------------------------------------------

function resolveGoogleClientId(config: Config): string {
  return config.googleClientId || process.env.GOOGLE_CLIENT_ID || "";
}

function resolveGoogleClientSecret(config: Config): string {
  return config.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || "";
}

export function buildGoogleAuthUrl(config: Config, redirectUri: string): string {
  const clientId = resolveGoogleClientId(config);
  if (!clientId) throw new Error("googleClientId not configured. Set it via `jira config set googleClientId` or GOOGLE_CLIENT_ID in .env");

  const params = new URLSearchParams({
    client_id: resolveGoogleClientId(config),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
  });

  return `${GOOGLE_AUTH_URL}?${params}`;
}

export async function exchangeGoogleCode(
  config: Config,
  code: string,
  redirectUri: string,
): Promise<void> {
  if (!resolveGoogleClientId(config) || !resolveGoogleClientSecret(config)) {
    throw new Error("googleClientId and googleClientSecret must be configured");
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: resolveGoogleClientId(config),
      client_secret: resolveGoogleClientSecret(config),
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  const data = await res.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || data.error) {
    throw new Error(`Google OAuth error: ${data.error_description ?? data.error ?? res.status}`);
  }

  if (!data.access_token || !data.refresh_token) {
    throw new Error("Missing tokens in Google OAuth response");
  }

  const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString();
  saveOAuthTokens("google", {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
  });
}

async function getValidAccessToken(config: Config): Promise<string> {
  const tokens = getOAuthTokens("google");
  if (!tokens) throw new Error("Google not connected. Connect via the UI preferences panel.");

  // Check if token is still valid (with 5 min buffer)
  if (new Date(tokens.expiresAt).getTime() > Date.now() + 5 * 60 * 1000) {
    return tokens.accessToken;
  }

  // Refresh
  if (!resolveGoogleClientId(config) || !resolveGoogleClientSecret(config)) {
    throw new Error("googleClientId and googleClientSecret required for token refresh");
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refreshToken,
      client_id: resolveGoogleClientId(config),
      client_secret: resolveGoogleClientSecret(config),
      grant_type: "refresh_token",
    }),
  });

  const data = await res.json() as {
    access_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (!res.ok || !data.access_token) {
    throw new Error(`Google token expired or revoked. Reconnect via Settings (jira tempo web → gear icon → Connect).`);
  }

  const expiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString();
  saveOAuthTokens("google", {
    accessToken: data.access_token,
    refreshToken: tokens.refreshToken,
    expiresAt,
  });

  return data.access_token;
}

export function isGoogleConnected(): boolean {
  return getOAuthTokens("google") !== null;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  summary: string;
  startDate: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  attendeeCount: number;
  isAllDay: boolean;
}

export async function getCalendarEvents(
  config: Config,
  from: string,
  to: string,
): Promise<CalendarEvent[]> {
  const token = await getValidAccessToken(config);

  const params = new URLSearchParams({
    timeMin: `${from}T00:00:00Z`,
    timeMax: `${to}T23:59:59Z`,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Calendar API error: ${res.status} ${text}`);
  }

  const data = await res.json() as {
    items?: Array<{
      summary?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      attendees?: Array<{ email: string }>;
    }>;
  };

  const events: CalendarEvent[] = [];
  for (const item of data.items ?? []) {
    const isAllDay = !!item.start?.date && !item.start?.dateTime;
    const startDt = item.start?.dateTime ?? item.start?.date;
    const endDt = item.end?.dateTime ?? item.end?.date;
    if (!startDt || !endDt) continue;

    const startDate = startDt.slice(0, 10);
    const startTime = item.start?.dateTime ? startDt.slice(11, 16) : "00:00";
    const endTime = item.end?.dateTime ? endDt.slice(11, 16) : "23:59";

    let durationSeconds = 0;
    if (item.start?.dateTime && item.end?.dateTime) {
      durationSeconds = Math.round((new Date(endDt).getTime() - new Date(startDt).getTime()) / 1000);
    }

    events.push({
      summary: item.summary ?? "(no title)",
      startDate,
      startTime,
      endTime,
      durationSeconds,
      attendeeCount: item.attendees?.length ?? 0,
      isAllDay,
    });
  }

  return events;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export interface ChatActivity {
  spaceName: string;
  messageCount: number;
  date: string;
}

export async function getChatActivity(
  config: Config,
  from: string,
  to: string,
): Promise<ChatActivity[]> {
  const token = await getValidAccessToken(config);

  // List spaces the user is in
  let spaces: Array<{ name: string; displayName: string }> = [];
  try {
    const res = await fetch(
      "https://chat.googleapis.com/v1/spaces?filter=spaceType%3D%22SPACE%22&pageSize=50",
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.ok) {
      const data = await res.json() as { spaces?: Array<{ name: string; displayName: string }> };
      spaces = data.spaces ?? [];
    }
  } catch {
    return []; // Chat API may not be available
  }

  const activities: ChatActivity[] = [];

  // For each space, count messages by date (limited to first 10 spaces)
  for (const space of spaces.slice(0, 10)) {
    try {
      const filter = `createTime > "${from}T00:00:00Z" AND createTime < "${to}T23:59:59Z"`;
      const res = await fetch(
        `https://chat.googleapis.com/v1/${space.name}/messages?filter=${encodeURIComponent(filter)}&pageSize=100`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!res.ok) continue;
      const data = await res.json() as { messages?: Array<{ createTime: string; sender?: { type: string } }> };

      // Count user's messages per date
      const byDate = new Map<string, number>();
      for (const msg of data.messages ?? []) {
        if (msg.sender?.type !== "HUMAN") continue;
        const date = msg.createTime.slice(0, 10);
        byDate.set(date, (byDate.get(date) ?? 0) + 1);
      }

      for (const [date, count] of byDate) {
        activities.push({ spaceName: space.displayName, messageCount: count, date });
      }
    } catch {
      continue;
    }
  }

  return activities;
}
