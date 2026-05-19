export type ProviderCalendarEvent = {
  title: string;
  startsAt: Date;
  endsAt: Date;
  attendees: string;
};

export type CalendarConnectionResult = {
  provider: string;
  providerUserId: string;
  events: ProviderCalendarEvent[];
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
};

export interface CalendarProvider {
  connect(email: string): Promise<CalendarConnectionResult>;
  getAuthorizationUrl?(state: string): string;
  connectWithCode?(code: string): Promise<CalendarConnectionResult>;
}

export class MockCalendarProvider implements CalendarProvider {
  async connect(email: string) {
    return {
      provider: "mock-google",
      providerUserId: email,
      events: [
        {
          title: "Daily Sync",
          startsAt: new Date("2026-05-12T16:00:00Z"),
          endsAt: new Date("2026-05-12T16:30:00Z"),
          attendees: "Product Team",
        },
        {
          title: "engineering sync",
          startsAt: new Date("2026-05-13T12:45:00Z"),
          endsAt: new Date("2026-05-13T13:00:00Z"),
          attendees: "Matt, Adrian",
        },
      ],
    };
  }
}

type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
};

type GoogleCalendarListResponse = {
  items?: Array<{
    summary?: string;
    start?: { dateTime?: string; date?: string };
    end?: { dateTime?: string; date?: string };
    attendees?: Array<{ email?: string; displayName?: string }>;
  }>;
};

export class GoogleCalendarProvider implements CalendarProvider {
  constructor(
    private readonly clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID,
    private readonly clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
    private readonly redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI,
  ) {}

  async connect(email: string) {
    return new MockCalendarProvider().connect(email);
  }

  getAuthorizationUrl(state: string) {
    if (!this.clientId || !this.redirectUri) {
      throw new Error("GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_REDIRECT_URI are required");
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
      scope: "openid email https://www.googleapis.com/auth/calendar.readonly",
      state,
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async connectWithCode(code: string) {
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      throw new Error("Google Calendar OAuth environment variables are required");
    }

    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenResponse.ok) {
      throw new Error(`Google token exchange failed: ${tokenResponse.status}`);
    }

    const token = (await tokenResponse.json()) as GoogleTokenResponse;
    const events = await this.fetchEvents(token.access_token);
    return {
      provider: "google",
      providerUserId: "google-calendar",
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : undefined,
      events,
    };
  }

  private async fetchEvents(accessToken: string) {
    const now = new Date();
    const timeMax = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin: now.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults: "20",
    });
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`Google Calendar event sync failed: ${response.status}`);
    }

    const calendar = (await response.json()) as GoogleCalendarListResponse;
    return (calendar.items ?? [])
      .filter((event) => event.summary && (event.start?.dateTime || event.start?.date))
      .map((event) => ({
        title: event.summary || "Untitled event",
        startsAt: new Date(event.start?.dateTime || `${event.start?.date}T00:00:00Z`),
        endsAt: new Date(event.end?.dateTime || `${event.end?.date}T00:30:00Z`),
        attendees:
          event.attendees
            ?.map((attendee) => attendee.displayName || attendee.email)
            .filter(Boolean)
            .join(", ") || "",
      }));
  }
}

export function getCalendarProvider(): CalendarProvider {
  if (process.env.CALENDAR_PROVIDER === "google") {
    return new GoogleCalendarProvider();
  }
  return new MockCalendarProvider();
}
