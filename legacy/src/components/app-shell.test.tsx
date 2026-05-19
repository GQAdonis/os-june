import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/app-shell";

const liveQuickNoteMock = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  reset: vi.fn(),
}));

const economyMeetingMock = vi.hoisted(() => ({
  start: vi.fn(),
  end: vi.fn(),
}));

const liveMeetingMock = vi.hoisted(() => ({
  start: vi.fn(),
  end: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("@/features/quick-notes/use-live-quick-note", () => ({
  useLiveQuickNote: () => ({
    status: "idle",
    transcript: "",
    error: null,
    start: liveQuickNoteMock.start,
    stop: liveQuickNoteMock.stop,
    reset: liveQuickNoteMock.reset,
  }),
}));

vi.mock("@/features/meetings/hooks/use-economy-meeting", () => ({
  useEconomyMeeting: () => ({
    status: "idle",
    note: null,
    elapsedSeconds: 0,
    audioLevel: 0,
    transcript: "",
    summary: "",
    error: null,
    start: economyMeetingMock.start,
    resumeCapture: vi.fn(),
    end: economyMeetingMock.end,
    stopCapture: vi.fn(),
    uploadChunk: vi.fn(),
  }),
}));

vi.mock("@/features/meetings/hooks/use-live-meeting", () => ({
  useLiveMeeting: () => ({
    status: "idle",
    note: null,
    elapsedSeconds: 0,
    audioLevel: 0,
    transcript: "",
    summary: "",
    error: null,
    start: liveMeetingMock.start,
    end: liveMeetingMock.end,
    stopCapture: vi.fn(),
    reset: liveMeetingMock.reset,
  }),
}));

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const bootstrapPayload = {
  user: { id: "user-1", name: "Alex", email: "alex@example.com" },
  workspace: { id: "workspace-1", name: "Workspace", slug: "workspace", plan: "free" },
  spaces: [{ id: "space-1", name: "Notes", icon: "N" }],
  notes: [],
  calendar: null,
  recentMessages: [],
  transcription: {
    configured: true,
    source: "environment",
    settings: {
      provider: "openai",
      model: "gpt-4o-mini-transcribe",
      baseUrl: null,
      apiKeyConfigured: true,
    },
  },
};

const quickNote = {
  id: "note-1",
  title: "New note",
  status: "RECORDING",
  visibility: "PRIVATE",
  date: new Date(0).toISOString(),
  summary: "",
  transcript: "",
  shares: [],
};

const existingNote = {
  id: "note-existing",
  title: "Customer recap",
  status: "READY",
  visibility: "PRIVATE",
  date: new Date(0).toISOString(),
  summary: "# Meeting Notes\n- Launch approved",
  transcript: "Microphone: Jun approved the launch. Adrian owns the recap.",
  shares: [],
};

describe("AppShell quick note timer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveQuickNoteMock.start.mockResolvedValue(undefined);
    liveQuickNoteMock.stop.mockResolvedValue({ ...quickNote, transcript: "Microphone: Done." });
    economyMeetingMock.start.mockResolvedValue({ ...quickNote, id: "meeting-batch", title: "New meeting" });
    economyMeetingMock.end.mockResolvedValue({ ...quickNote, id: "meeting-batch", title: "New meeting" });
    liveMeetingMock.start.mockResolvedValue({ ...quickNote, id: "meeting-live", title: "New meeting" });
    liveMeetingMock.end.mockResolvedValue({ ...quickNote, id: "meeting-live", title: "New meeting" });
    vi.stubGlobal("RTCPeerConnection", class {});
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/bootstrap") return jsonResponse(bootstrapPayload);
      if (url === "/api/meetings" && init?.method === "POST") return jsonResponse({ note: quickNote });
      return jsonResponse({});
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("freezes the quick note elapsed time after recording stops", async () => {
    render(<AppShell />);
    const quickNoteButton = await screen.findByRole("button", { name: "+ Quick note" });

    vi.useFakeTimers();
    vi.setSystemTime(0);

    await act(async () => {
      fireEvent.click(quickNoteButton);
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1250);
    });
    expect(screen.getAllByText("00:01").length).toBeGreaterThan(0);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Stop recording"));
    });

    act(() => {
      vi.advanceTimersByTime(2500);
    });

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Resume" }).at(-1)!);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    expect(screen.getAllByText("00:01").length).toBeGreaterThan(0);
    expect(screen.queryByText("00:03")).not.toBeInTheDocument();
  });
});

describe("AppShell live meeting mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    liveQuickNoteMock.start.mockResolvedValue(undefined);
    liveQuickNoteMock.stop.mockResolvedValue({ ...quickNote, transcript: "Microphone: Done." });
    economyMeetingMock.start.mockResolvedValue({ ...quickNote, id: "meeting-batch", title: "New meeting" });
    economyMeetingMock.end.mockResolvedValue({ ...quickNote, id: "meeting-batch", title: "New meeting" });
    liveMeetingMock.start.mockResolvedValue({ ...quickNote, id: "meeting-live", title: "New meeting" });
    liveMeetingMock.end.mockResolvedValue({ ...quickNote, id: "meeting-live", title: "New meeting" });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/bootstrap") return jsonResponse(bootstrapPayload);
      if (url === "/api/meetings" && init?.method === "POST") return jsonResponse({ note: quickNote });
      return jsonResponse({});
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts meetings with the live meeting hook when Live mode is selected", async () => {
    render(<AppShell />);
    const startButton = await screen.findByRole("button", { name: "Start Meeting" });

    await act(async () => {
      fireEvent.click(startButton);
      await Promise.resolve();
    });

    expect(liveMeetingMock.start).toHaveBeenCalledWith("New meeting");
    expect(economyMeetingMock.start).not.toHaveBeenCalled();
  });

  it("shows a permission action when live meeting system audio cannot start", async () => {
    const openPermissions = vi.fn().mockResolvedValue({ ok: true });
    liveMeetingMock.start.mockRejectedValueOnce(new Error("System audio permission is required to start live meeting capture."));
    Object.defineProperty(window, "openNotepadDesktop", {
      configurable: true,
      value: {
        isDesktop: true,
        platform: "darwin",
        recorder: { openPermissions },
      },
    });
    render(<AppShell />);
    const startButton = await screen.findByRole("button", { name: "Start Meeting" });

    await act(async () => {
      fireEvent.click(startButton);
      await Promise.resolve();
    });

    expect(await screen.findByText("System audio permission is required to start live meeting capture.")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open audio permissions" }));
    });
    expect(openPermissions).toHaveBeenCalled();
  });

  it("allows ending live meetings before the first visible transcript so realtime can flush", async () => {
    render(<AppShell />);
    const startButton = await screen.findByRole("button", { name: "Start Meeting" });

    await act(async () => {
      fireEvent.click(startButton);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "End Meeting" }));
      await Promise.resolve();
    });

    expect(liveMeetingMock.end).toHaveBeenCalled();
  });
});

describe("AppShell note composer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("RTCPeerConnection", class {});
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn(),
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === "/api/bootstrap") return jsonResponse({ ...bootstrapPayload, notes: [existingNote] });
      if (url === "/api/notes/note-existing/chat" && init?.method === "POST") {
        return jsonResponse({
          message: {
            id: "message-1",
            role: "assistant",
            content: "Subject: Launch follow-up\n\nHi team, here are the decisions and next steps.",
          },
        });
      }
      return jsonResponse({});
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("runs predefined note prompts through note chat and renders the answer", async () => {
    render(<AppShell />);
    fireEvent.click(await screen.findByText("Customer recap"));

    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Write follow up email" }).at(-1)!);
      await Promise.resolve();
    });

    expect(await screen.findByText("Subject: Launch follow-up")).toBeInTheDocument();
    expect(screen.getByText("Hi team, here are the decisions and next steps.")).toBeInTheDocument();
    const chatRequest = JSON.parse(String(vi.mocked(fetch).mock.calls.find(([url]) => url === "/api/notes/note-existing/chat")?.[1]?.body));
    expect(chatRequest.question).toContain("follow-up email");
  });
});
