import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLiveQuickNote } from "@/features/quick-notes/use-live-quick-note";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

class FakeRTCDataChannel {
  readyState: RTCDataChannelState = "open";
  onmessage: ((event: MessageEvent) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = "closed";
  });
}

class FakeRTCPeerConnection {
  static instances: FakeRTCPeerConnection[] = [];
  channel = new FakeRTCDataChannel();
  addTrack = vi.fn();
  createDataChannel = vi.fn(() => this.channel as unknown as RTCDataChannel);
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "local-sdp" }) as RTCSessionDescriptionInit);
  setLocalDescription = vi.fn();
  setRemoteDescription = vi.fn();
  close = vi.fn();

  constructor() {
    FakeRTCPeerConnection.instances.push(this);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeRTCPeerConnection.instances = [];
});

describe("useLiveQuickNote", () => {
  it("streams realtime transcript events and persists transcript on stop", async () => {
    const trackStop = vi.fn();
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [{ id: "audio-track" }],
          getTracks: () => [{ stop: trackStop }],
        }),
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("remote-sdp", { status: 200 }));
    const localFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: "eph_test" }))
      .mockResolvedValueOnce(jsonResponse({ note: { id: "note-1", title: "New note", transcript: "Microphone: Hola mundo.", summary: "" } }));
    const { result } = renderHook(() => useLiveQuickNote({ fetch: localFetch }));

    await act(async () => {
      await result.current.start("note-1");
    });
    await act(async () => {
      FakeRTCPeerConnection.instances[0]?.channel.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.delta",
          item_id: "item-1",
          delta: "Hola ",
        }),
      } as MessageEvent);
      FakeRTCPeerConnection.instances[0]?.channel.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item-1",
          transcript: "Hola mundo.",
        }),
      } as MessageEvent);
    });

    expect(result.current.transcript).toBe("Hola mundo.");

    await act(async () => {
      await result.current.stop();
    });

    expect(localFetch).toHaveBeenLastCalledWith(
      "/api/meetings/note-1/live-transcript",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ transcript: "Hola mundo." }),
      }),
    );
    expect(trackStop).toHaveBeenCalled();
  });

  it("preserves previously persisted transcript when resuming live capture", async () => {
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [{ id: "audio-track" }],
          getTracks: () => [{ stop: vi.fn() }],
        }),
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("remote-sdp", { status: 200 }));
    const localFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: "eph_test" }))
      .mockResolvedValueOnce(
        jsonResponse({
          note: {
            id: "note-1",
            title: "New note",
            transcript: "Microphone: Primera parte.\nSegunda parte.",
            summary: "",
          },
        }),
      );
    const { result } = renderHook(() => useLiveQuickNote({ fetch: localFetch }));

    await act(async () => {
      await result.current.start("note-1", "Microphone: Primera parte.");
    });
    await act(async () => {
      FakeRTCPeerConnection.instances[0]?.channel.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "item-2",
          transcript: "Segunda parte.",
        }),
      } as MessageEvent);
    });

    await act(async () => {
      await result.current.stop();
    });

    expect(localFetch).toHaveBeenLastCalledWith(
      "/api/meetings/note-1/live-transcript",
      expect.objectContaining({
        body: JSON.stringify({ transcript: "Primera parte.\nSegunda parte." }),
      }),
    );
  });
});
