import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLiveMeeting } from "@/features/meetings/hooks/use-live-meeting";

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

class FakeRTCDataChannel {
  readyState: RTCDataChannelState = "open";
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
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

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({} as CloseEvent);
  });

  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.({} as Event));
  }

  send(data: string) {
    this.sent.push(data);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  FakeRTCPeerConnection.instances = [];
  FakeWebSocket.instances = [];
});

describe("useLiveMeeting", () => {
  it("streams microphone and system audio, persists the labeled transcript, and finalizes the meeting", async () => {
    const trackStop = vi.fn();
    const stopStream = vi.fn().mockResolvedValue({ ok: true });
    let systemAudioHandler: ((payload: { data: string; sampleRate: number; channels: number }) => void) | null = null;
    vi.stubGlobal("RTCPeerConnection", FakeRTCPeerConnection);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getAudioTracks: () => [{ id: "audio-track" }],
          getTracks: () => [{ stop: trackStop }],
        }),
      },
    });
    Object.defineProperty(window, "openNotepadDesktop", {
      configurable: true,
      value: {
        isDesktop: true,
        platform: "darwin",
        recorder: {
          startStream: vi.fn().mockResolvedValue({ ok: true }),
          stopStream,
          onAudio: vi.fn((handler) => {
            systemAudioHandler = handler;
            return vi.fn();
          }),
        },
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("remote-sdp", { status: 200 }));
    const localFetch = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ value: "mic-token", model: "gpt-realtime-whisper" }))
      .mockResolvedValueOnce(jsonResponse({ value: "system-token", model: "gpt-realtime-whisper" }))
      .mockResolvedValueOnce(jsonResponse({ note: { id: "note-1", title: "Live meeting", transcript: "", summary: "" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          note: {
            id: "note-1",
            title: "Live meeting",
            transcript: "- Microphone: I will recap.\n- System: Approved.\n- Microphone: I will send the recap.",
            summary: "",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          note: {
            id: "note-1",
            title: "Live meeting",
            transcript: "- Microphone: I will recap.\n- System: Approved.\n- Microphone: I will send the recap.",
            summary: "# Meeting Notes\n- Approved.",
          },
        }),
      );
    const { result } = renderHook(() => useLiveMeeting({ fetch: localFetch, flushDelayMs: 0 }));

    await act(async () => {
      await result.current.start("Live meeting");
    });
    await act(async () => {
      FakeRTCPeerConnection.instances[0]?.channel.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "mic-1",
          transcript: "I will recap.",
        }),
      } as MessageEvent);
      vi.spyOn(Date, "now")
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(700)
        .mockReturnValueOnce(1700);
      systemAudioHandler?.({ data: pcm16Base64([8192, 8192]), sampleRate: 24000, channels: 1 });
      systemAudioHandler?.({ data: pcm16Base64([8192, 8192]), sampleRate: 24000, channels: 1 });
      systemAudioHandler?.({ data: pcm16Base64([0, 0]), sampleRate: 24000, channels: 1 });
      FakeWebSocket.instances[0]?.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "sys-1",
          transcript: "Approved.",
        }),
      } as MessageEvent);
      FakeRTCPeerConnection.instances[0]?.channel.onmessage?.({
        data: JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "mic-2",
          transcript: "I will send the recap.",
        }),
      } as MessageEvent);
    });

    expect(FakeWebSocket.instances[0]?.url).toBe("wss://api.openai.com/v1/realtime");
    expect(FakeWebSocket.instances[0]?.protocols).toContain("openai-insecure-api-key.system-token");
    expect(FakeWebSocket.instances[0]?.sent[0]).toContain('"type":"session.update"');
    expect(FakeWebSocket.instances[0]?.sent[0]).not.toContain("turn_detection");
    expect(FakeWebSocket.instances[0]?.sent).toContain(JSON.stringify({ type: "input_audio_buffer.append", audio: pcm16Base64([8192, 8192]) }));
    expect(FakeWebSocket.instances[0]?.sent).toContain(JSON.stringify({ type: "input_audio_buffer.commit" }));
    expect(result.current.transcript).toBe("- Microphone: I will recap.\n- System: Approved.\n- Microphone: I will send the recap.");

    await act(async () => {
      await result.current.end();
    });

    expect(stopStream).toHaveBeenCalled();
    expect(trackStop).toHaveBeenCalled();
    expect(FakeRTCPeerConnection.instances[0]?.channel.sent).toContain(JSON.stringify({ type: "input_audio_buffer.commit" }));
    expect(FakeWebSocket.instances[0]?.sent).toContain(JSON.stringify({ type: "input_audio_buffer.commit" }));
    expect(localFetch).toHaveBeenNthCalledWith(
      4,
      "/api/meetings/note-1/live-transcript",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ transcript: "- Microphone: I will recap.\n- System: Approved.\n- Microphone: I will send the recap." }),
      }),
    );
    expect(localFetch).toHaveBeenNthCalledWith(5, "/api/meetings/note-1/end", { method: "POST" });
    expect(result.current.status).toBe("ended");
    expect(result.current.summary).toBe("# Meeting Notes\n- Approved.");
  });
});

function pcm16Base64(samples: number[]) {
  return btoa(
    String.fromCharCode(
      ...samples.flatMap((sample) => {
        const clamped = Math.max(-32768, Math.min(32767, sample));
        return [clamped & 0xff, (clamped >> 8) & 0xff];
      }),
    ),
  );
}
