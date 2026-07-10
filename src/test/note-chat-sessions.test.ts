import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetNoteChatSession,
  noteChatSessionIdFor,
  rememberNoteChatSession,
} from "../components/note-chat/noteChatSessions";
import { useNoteChat } from "../components/note-chat/useNoteChat";

const mocks = vi.hoisted(() => ({
  ensureHermesBridgeSession: vi.fn(),
  gatewayRequest: vi.fn(),
  hermesBridgeImageDataUrl: vi.fn(),
  hermesBridgeSessionMessages: vi.fn(),
  hermesBridgeStatus: vi.fn(),
  startHermesBridge: vi.fn(),
}));

vi.mock("../lib/tauri", () => ({
  ensureHermesBridgeSession: mocks.ensureHermesBridgeSession,
  hermesBridgeImageDataUrl: mocks.hermesBridgeImageDataUrl,
  hermesBridgeSessionMessages: mocks.hermesBridgeSessionMessages,
  hermesBridgeStatus: mocks.hermesBridgeStatus,
  startHermesBridge: mocks.startHermesBridge,
}));

vi.mock("../lib/hermes-gateway", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hermes-gateway")>()),
  HermesGatewayClient: class {
    connect = vi.fn();
    close = vi.fn();
    onEvent = vi.fn();
    onClose = vi.fn();
    request = mocks.gatewayRequest;
  },
}));

const STORAGE_KEY = "june.noteChat.sessionsByNote.v1";

describe("note chat session map", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    mocks.hermesBridgeStatus.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    mocks.hermesBridgeSessionMessages.mockResolvedValue({ messages: [] });
    mocks.startHermesBridge.mockResolvedValue({
      running: true,
      connection: { port: 61234, wsUrl: "ws://127.0.0.1:61234" },
    });
    mocks.gatewayRequest.mockImplementation((method: string) => {
      if (method === "session.resume") {
        return Promise.resolve({ session_id: "runtime-note-chat" });
      }
      return Promise.resolve({});
    });
  });

  it("remembers and recalls the session for a note", () => {
    rememberNoteChatSession("note-1", "sess-a");
    rememberNoteChatSession("note-2", "sess-b");

    expect(noteChatSessionIdFor("note-1")).toBe("sess-a");
    expect(noteChatSessionIdFor("note-2")).toBe("sess-b");
    expect(noteChatSessionIdFor("note-3")).toBeUndefined();
  });

  it("replaces the pairing when a note gets a new session", () => {
    rememberNoteChatSession("note-1", "sess-a");
    rememberNoteChatSession("note-1", "sess-c");

    expect(noteChatSessionIdFor("note-1")).toBe("sess-c");
  });

  it("forgets a pairing without touching other notes", () => {
    rememberNoteChatSession("note-1", "sess-a");
    rememberNoteChatSession("note-2", "sess-b");

    forgetNoteChatSession("note-1");

    expect(noteChatSessionIdFor("note-1")).toBeUndefined();
    expect(noteChatSessionIdFor("note-2")).toBe("sess-b");
  });

  it("survives corrupt storage", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(noteChatSessionIdFor("note-1")).toBeUndefined();

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(["sess-a"]));
    expect(noteChatSessionIdFor("note-1")).toBeUndefined();

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ "note-1": 7 }));
    expect(noteChatSessionIdFor("note-1")).toBeUndefined();

    // A write over corrupt storage heals it.
    rememberNoteChatSession("note-1", "sess-a");
    expect(noteChatSessionIdFor("note-1")).toBe("sess-a");
  });

  it("keeps a manual stored-session title through reopen, model change, and registration retry", async () => {
    rememberNoteChatSession("note-1", "stored-note-chat");
    let persistedTitle = "Manual launch blockers";
    let registrationAttempt = 0;
    mocks.ensureHermesBridgeSession.mockImplementation(
      async (input: { sessionId: string; title?: string; model?: string }) => {
        registrationAttempt += 1;
        if (registrationAttempt === 1) throw new Error("registration unavailable");
        if (input.title) persistedTitle = input.title;
        return {};
      },
    );

    const { result } = renderHook(() => useNoteChat({ id: "note-1", title: "Launch planning" }));

    await waitFor(() => expect(result.current.storedSessionId).toBe("stored-note-chat"));
    act(() => result.current.setSessionModel("kimi-k2-6"));

    let accepted = false;
    await act(async () => {
      accepted = await result.current.submit("What remains blocked?");
    });

    expect(accepted).toBe(true);
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("session.resume", {
      session_id: "stored-note-chat",
      cols: 96,
    });
    expect(mocks.gatewayRequest).toHaveBeenCalledWith("command.dispatch", {
      session_id: "runtime-note-chat",
      command: "/model kimi-k2-6",
    });
    expect(mocks.ensureHermesBridgeSession).toHaveBeenCalledTimes(2);
    expect(persistedTitle).toBe("Manual launch blockers");
    for (const [input] of mocks.ensureHermesBridgeSession.mock.calls) {
      expect(input).not.toHaveProperty("title");
    }
  });
});
