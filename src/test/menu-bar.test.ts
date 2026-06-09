import { describe, expect, it } from "vitest";
import { buildAgentMenuBarState } from "../lib/menu-bar";
import type { HermesSessionInfo } from "../lib/tauri";

const sessions: HermesSessionInfo[] = [
  {
    id: "session-old",
    title: "Older work",
    preview: "First pass",
    last_active: "2026-06-04T12:00:00Z",
    message_count: 2,
  },
  {
    id: "session-new",
    title: "Newer work",
    preview: "Reviewing changes",
    last_active: "2026-06-04T13:00:00Z",
    message_count: 4,
  },
];

describe("buildAgentMenuBarState", () => {
  it("summarizes active counts and orders recent sessions", () => {
    const state = buildAgentMenuBarState({
      sessions,
      workingSessionIds: new Set(["session-old"]),
      waitingSessionIds: new Set(["session-new"]),
      now: new Date("2026-06-04T14:00:00Z"),
    });

    expect(state.activeCount).toBe(2);
    expect(state.needsUserCount).toBe(1);
    expect(state.sessions.map((session) => session.id)).toEqual([
      "session-new",
      "session-old",
    ]);
    expect(state.sessions[0]).toMatchObject({
      title: "Newer work",
      subtitle: "Reviewing changes",
      status: "waitingForUser",
    });
    expect(state.sessions[1]).toMatchObject({
      title: "Older work",
      status: "running",
    });
  });

  it("keeps the last status summary when no session exists yet", () => {
    const state = buildAgentMenuBarState({
      sessions: [],
      workingSessionIds: new Set(),
      waitingSessionIds: new Set(),
      lastStatus: {
        prompt: "Make a launch checklist",
        status: "starting",
        summary: "Starting June.",
      },
      now: new Date("2026-06-04T14:00:00Z"),
    });

    expect(state.activeCount).toBe(0);
    expect(state.sessions).toEqual([]);
    expect(state.lastStatus).toMatchObject({
      title: "Make a launch checklist",
      status: "starting",
      summary: "Starting June.",
    });
  });
});
