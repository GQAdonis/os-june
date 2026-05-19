import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEconomyMeeting } from "@/features/meetings/hooks/use-economy-meeting";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);
  static deferStop = false;
  static pendingStops: Array<() => void> = [];

  state: RecordingState = "inactive";
  mimeType: string;
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;
  start = vi.fn((timeslice?: number) => {
    this.state = "recording";
    this.startTimeslice = timeslice;
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    if (FakeMediaRecorder.deferStop) {
      FakeMediaRecorder.pendingStops.push(() => this.finishStop());
      return;
    }
    this.finishStop();
  });
  finishStop() {
    this.ondataavailable?.({ data: new Blob(["chunk"], { type: this.mimeType }) } as BlobEvent);
    this.onstop?.();
  }
  requestData = vi.fn();
  startTimeslice?: number;

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.isTypeSupported.mockClear();
  FakeMediaRecorder.deferStop = false;
  FakeMediaRecorder.pendingStops = [];
});

describe("useEconomyMeeting", () => {
  it("starts and ends a note-backed meeting session", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ note: { id: "note-1", title: "Planning meeting", transcript: "", summary: "" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          note: { id: "note-1", title: "Planning meeting", status: "READY", transcript: "Microphone: Approved.", summary: "# Final" },
        }),
      );
    const { result } = renderHook(() => useEconomyMeeting({ fetch, captureMicrophone: false }));

    await act(async () => {
      await result.current.start("Planning meeting");
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/meetings",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "Planning meeting" }),
      }),
    );
    expect(result.current.status).toBe("recording");
    expect(result.current.note?.id).toBe("note-1");

    await act(async () => {
      await result.current.end();
    });

    expect(fetch).toHaveBeenLastCalledWith("/api/meetings/note-1/end", { method: "POST" });
    expect(result.current.status).toBe("ended");
    expect(result.current.note?.summary).toBe("# Final");
  });

  it("sends supplemental text when ending a meeting", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ note: { id: "note-1", title: "Quick note", transcript: "", summary: "" } }))
      .mockResolvedValueOnce(jsonResponse({ note: { id: "note-1", title: "Quick note", status: "READY", transcript: "", summary: "# Final" } }));
    const { result } = renderHook(() => useEconomyMeeting({ fetch, captureMicrophone: false }));

    await act(async () => {
      await result.current.start("Quick note");
    });
    await act(async () => {
      await result.current.end("Manual note: send recap.");
    });

    expect(fetch).toHaveBeenLastCalledWith(
      "/api/meetings/note-1/end",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ supplementalText: "Manual note: send recap." }),
      }),
    );
  });

  it("uploads an external chunk for the active meeting", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ note: { id: "note-1", title: "Planning meeting", transcript: "", summary: "" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          transcript: "System audio: Approved.",
          note: { id: "note-1", title: "Planning meeting", transcript: "System audio: Approved.", summary: "" },
        }),
      );
    const { result } = renderHook(() => useEconomyMeeting({ fetch, captureMicrophone: false }));

    await act(async () => {
      await result.current.start("Planning meeting");
    });
    await act(async () => {
      await result.current.uploadChunk({
        source: "system",
        blob: new Blob(["audio"], { type: "audio/wav" }),
        startSec: 0,
        endSec: 30,
      });
    });

    expect(fetch).toHaveBeenLastCalledWith(
      "/api/meetings/note-1/chunks",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    );
    expect(result.current.transcript).toBe("System audio: Approved.");
  });

  it("resumes capture for the current note without creating another meeting", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const trackStop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] }),
      },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ note: { id: "note-1", title: "Quick note", transcript: "", summary: "" } }))
      .mockResolvedValue(jsonResponse({ note: { id: "note-1", title: "Quick note", transcript: "Microphone: chunk", summary: "" }, transcript: "chunk" }));
    const { result } = renderHook(() => useEconomyMeeting({ fetch, chunkMs: 1000 }));

    await act(async () => {
      await result.current.start("Quick note");
    });
    await act(async () => {
      await result.current.stopCapture();
    });
    await act(async () => {
      await result.current.resumeCapture();
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/meetings", expect.any(Object));
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(FakeMediaRecorder.instances[1]?.start).toHaveBeenCalledWith();
  });

  it("surfaces chunk upload failures to the caller and hook state", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ note: { id: "note-1", title: "Quick note", transcript: "", summary: "" } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "OpenAI transcription rejected the API key. Check transcription settings." }), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
      );
    const { result } = renderHook(() => useEconomyMeeting({ fetch, captureMicrophone: false }));

    await act(async () => {
      await result.current.start("Quick note");
    });

    let uploadError: unknown;
    await act(async () => {
      try {
        await result.current.uploadChunk({
          source: "system",
          blob: new Blob(["audio"], { type: "audio/wav" }),
          startSec: 0,
          endSec: 1,
        });
      } catch (error) {
        uploadError = error;
      }
    });

    expect(uploadError).toBeInstanceOf(Error);
    expect((uploadError as Error).message).toBe("OpenAI transcription rejected the API key. Check transcription settings.");
    await waitFor(() => {
      expect(result.current.error).toBe("OpenAI transcription rejected the API key. Check transcription settings.");
    });
  });

  it("rotates microphone recorders so each chunk is a standalone audio file", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const trackStop = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: trackStop }] }),
      },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ note: { id: "note-1", title: "Quick note", transcript: "", summary: "" } }))
      .mockResolvedValue(jsonResponse({ note: { id: "note-1", title: "Quick note", transcript: "Microphone: chunk", summary: "" }, transcript: "chunk" }));
    const { result } = renderHook(() => useEconomyMeeting({ fetch, chunkMs: 1000 }));

    await act(async () => {
      await result.current.start("Quick note");
    });

    expect(FakeMediaRecorder.instances[0]?.start).toHaveBeenCalledWith();

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(FakeMediaRecorder.instances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances[1]?.start).toHaveBeenCalledWith();
    expect(FakeMediaRecorder.instances).toHaveLength(2);
  });

  it("waits for a recorder to finish before starting the next chunk", async () => {
    vi.useFakeTimers();
    FakeMediaRecorder.deferStop = true;
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
      },
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ note: { id: "note-1", title: "Quick note", transcript: "", summary: "" } }))
      .mockResolvedValue(jsonResponse({ note: { id: "note-1", title: "Quick note", transcript: "Microphone: chunk", summary: "" }, transcript: "chunk" }));
    const { result } = renderHook(() => useEconomyMeeting({ fetch, chunkMs: 1000 }));

    await act(async () => {
      await result.current.start("Quick note");
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });

    expect(FakeMediaRecorder.instances[0]?.stop).toHaveBeenCalledTimes(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    await act(async () => {
      FakeMediaRecorder.pendingStops.shift()?.();
      await Promise.resolve();
    });

    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(FakeMediaRecorder.instances[1]?.start).toHaveBeenCalledWith();
  });
});
