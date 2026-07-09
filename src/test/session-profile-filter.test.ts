import { describe, expect, it, vi } from "vitest";
import { normalizeHermesSessionsResponse } from "../lib/hermes-adapter";
import { filterAgentSessionsForProfile, sessionProfileMap } from "../lib/session-profile-filter";

vi.mock("../lib/tauri", () => ({
  deleteHermesBridgeSession: vi.fn(),
  hermesBridgeSessionMessages: vi.fn(),
  hermesBridgeSessions: vi.fn(),
}));

describe("session profile filtering", () => {
  it("shows only the active profile's chat sessions after Hermes list normalization", () => {
    const normalized = normalizeHermesSessionsResponse({
      sessions: [
        {
          id: "work-session",
          title: "Work session",
          last_active: "2026-07-09T12:00:00Z",
        },
        {
          id: "other-session",
          title: "Other session",
          last_active: "2026-07-09T11:00:00Z",
        },
        {
          id: "default-row-session",
          title: "Default mapped session",
          last_active: "2026-07-09T10:00:00Z",
        },
        {
          id: "legacy-session",
          title: "Legacy session",
          last_active: "2026-07-09T09:00:00Z",
        },
        {
          id: "delegated-worker",
          source: "tool",
          title: "Delegated worker",
          last_active: "2026-07-09T08:00:00Z",
        },
        {
          id: "cron_digest_20260709_070000",
          source: "cron",
          title: "Digest run",
          last_active: "2026-07-09T07:00:00Z",
        },
      ],
    });
    const profiles = sessionProfileMap([
      { sessionId: "work-session", profile: "work" },
      { sessionId: "other-session", profile: "other" },
      { sessionId: "default-row-session", profile: "default" },
      { sessionId: "cron_digest_20260709_070000", profile: "work" },
    ]);

    expect(filterAgentSessionsForProfile(normalized, profiles, "work").map((s) => s.id)).toEqual([
      "work-session",
    ]);
    expect(filterAgentSessionsForProfile(normalized, profiles, "default").map((s) => s.id)).toEqual(
      ["default-row-session", "legacy-session"],
    );
  });
});
