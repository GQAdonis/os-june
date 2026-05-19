"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  byteTimeDomainLevel,
  applyLiveTranscriptEvent,
  formatLiveTranscriptTurns,
  initialLiveTurnBoundaryState,
  observeLiveTurnAudio,
  pcm16Base64Level,
  type LiveTranscriptSource,
  type LiveTranscriptTurn,
  type LiveTurnBoundaryState,
} from "@/features/meetings/live-turns";
import type { EconomyMeetingStatus, MeetingNote } from "@/features/meetings/types";
import type { RealtimeTranscriptEvent } from "@/features/quick-notes/realtime-transcript";

type LiveMeetingFetch = (url: string, init?: RequestInit) => Promise<Response>;

type MeetingPayload = {
  note: MeetingNote;
};

type RealtimeTokenPayload = {
  value: string;
  model?: string;
};

type SystemAudioPayload = {
  data: string;
  sampleRate: number;
  channels: number;
};

const realtimeCommitMessage = JSON.stringify({ type: "input_audio_buffer.commit" });
const liveTurnBoundaryOptions = {
  silenceThreshold: 0.02,
  silenceMs: 900,
  minSpeechMs: 600,
  maxTurnMs: 12_000,
};
const microphoneTurnMonitorMs = 250;

export function useLiveMeeting({
  fetch: fetchOption,
  flushDelayMs = 1200,
}: {
  fetch?: LiveMeetingFetch;
  flushDelayMs?: number;
} = {}) {
  const fetchRef = useRef<LiveMeetingFetch>(fetchOption || ((url, init) => window.fetch(url, init)));
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const systemSocketRef = useRef<WebSocket | null>(null);
  const removeSystemAudioListenerRef = useRef<(() => void) | null>(null);
  const stopMicrophoneTurnMonitorRef = useRef<(() => void) | null>(null);
  const sawFirstSystemAudioRef = useRef(false);
  const sawFirstSystemTranscriptEventRef = useRef(false);
  const noteRef = useRef<MeetingNote | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const systemTurnBoundaryRef = useRef<LiveTurnBoundaryState>(initialLiveTurnBoundaryState());
  const transcriptTurnsRef = useRef<LiveTranscriptTurn[]>([]);
  const [status, setStatus] = useState<EconomyMeetingStatus>("idle");
  const [note, setNote] = useState<MeetingNote | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [audioLevel] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refreshTranscript = useCallback(() => {
    setTranscript(formatLiveTranscriptTurns(transcriptTurnsRef.current));
  }, []);

  const applyTranscriptEvent = useCallback(
    (source: LiveTranscriptSource, event: RealtimeTranscriptEvent) => {
      transcriptTurnsRef.current = applyLiveTranscriptEvent(transcriptTurnsRef.current, source, event);
      refreshTranscript();
    },
    [refreshTranscript],
  );

  const applyMicrophoneEvent = useCallback(
    (event: RealtimeTranscriptEvent) => {
      applyTranscriptEvent("microphone", event);
    },
    [applyTranscriptEvent],
  );

  const applySystemEvent = useCallback(
    (event: RealtimeTranscriptEvent) => {
      applyTranscriptEvent("system", event);
    },
    [applyTranscriptEvent],
  );

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    startedAtRef.current = Date.now();
    timerRef.current = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);
  }, [stopTimer]);

  const persistTranscript = useCallback(async () => {
    const currentNote = noteRef.current;
    if (!currentNote) return null;
    const currentTranscript = formatLiveTranscriptTurns(transcriptTurnsRef.current);
    const response = await fetchRef.current(`/api/meetings/${encodeURIComponent(currentNote.id)}/live-transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: currentTranscript }),
    });
    if (!response.ok) throw new Error(await readErrorResponse(response));
    const payload = (await response.json()) as MeetingPayload;
    noteRef.current = payload.note;
    setNote(payload.note);
    setSummary(payload.note.summary || "");
    return payload.note;
  }, []);

  const startMicrophone = useCallback(
    async () => {
      const token = await requestRealtimeToken(fetchRef.current);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const peer = new RTCPeerConnection();
      const channel = peer.createDataChannel("oai-events");
      stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));
      channel.onmessage = (message) => {
        try {
          applyMicrophoneEvent(JSON.parse(String(message.data)) as RealtimeTranscriptEvent);
        } catch {
          // Ignore malformed realtime events.
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.value}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp || "",
      });
      if (!sdpResponse.ok) throw new Error(`OpenAI realtime microphone connection failed: ${sdpResponse.status}`);
      await peer.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });

      peerRef.current = peer;
      channelRef.current = channel;
      micStreamRef.current = stream;
      stopMicrophoneTurnMonitorRef.current = startMicrophoneTurnMonitor(stream, channel);
    },
    [applyMicrophoneEvent],
  );

  const startSystemAudio = useCallback(async () => {
    const recorder = window.openNotepadDesktop?.recorder;
    if (!recorder?.startStream || !recorder.stopStream || !recorder.onAudio) {
      throw new Error("Live meeting system audio requires the desktop app with native system audio capture.");
    }

    const token = await requestRealtimeToken(fetchRef.current);
    const socket = await openRealtimeTranscriptionSocket(token, (event) => {
      if (!sawFirstSystemTranscriptEventRef.current && event.type?.startsWith("conversation.item.input_audio_transcription")) {
        sawFirstSystemTranscriptEventRef.current = true;
        console.info("[live-meeting] first system transcript event received");
      }
      if (event.type === "error") {
        const message = readRealtimeErrorEvent(event);
        setError(message);
        console.error("[live-meeting] system realtime error", message);
        return;
      }
      applySystemEvent(event);
    });
    systemSocketRef.current = socket;
    removeSystemAudioListenerRef.current = recorder.onAudio((payload: SystemAudioPayload) => {
      if (payload.sampleRate !== 24000 || payload.channels !== 1) return;
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!sawFirstSystemAudioRef.current) {
        sawFirstSystemAudioRef.current = true;
        console.info("[live-meeting] first system audio chunk received", {
          bytes: Math.round((payload.data.length * 3) / 4),
          sampleRate: payload.sampleRate,
          channels: payload.channels,
        });
      }
      socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: payload.data }));
      const boundary = observeLiveTurnAudio(
        systemTurnBoundaryRef.current,
        { now: Date.now(), level: pcm16Base64Level(payload.data) },
        liveTurnBoundaryOptions,
      );
      systemTurnBoundaryRef.current = boundary.state;
      if (boundary.shouldCommit) socket.send(realtimeCommitMessage);
    });

    const started = await recorder.startStream();
    if (!started.ok) throw new Error(started.error || "System audio permission is required to start live meeting capture.");
  }, [applySystemEvent]);

  const stopCapture = useCallback(async () => {
    stopTimer();
    stopMicrophoneTurnMonitorRef.current?.();
    stopMicrophoneTurnMonitorRef.current = null;
    closeRealtimeResources(peerRef.current, channelRef.current, micStreamRef.current, systemSocketRef.current);
    peerRef.current = null;
    channelRef.current = null;
    micStreamRef.current = null;
    systemSocketRef.current = null;
    removeSystemAudioListenerRef.current?.();
    removeSystemAudioListenerRef.current = null;
    await window.openNotepadDesktop?.recorder?.stopStream?.().catch(() => undefined);
  }, [stopTimer]);

  const flushRealtimeInputs = useCallback(async () => {
    const channel = channelRef.current;
    if (channel?.readyState === "open") channel.send(realtimeCommitMessage);
    const socket = systemSocketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(realtimeCommitMessage);
    if (flushDelayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, flushDelayMs));
  }, [flushDelayMs]);

  const start = useCallback(
    async (title = "New meeting") => {
      setStatus("starting");
      setError(null);
      setElapsedSeconds(0);
      setTranscript("");
      setSummary("");
      sawFirstSystemAudioRef.current = false;
      sawFirstSystemTranscriptEventRef.current = false;
      systemTurnBoundaryRef.current = initialLiveTurnBoundaryState(Date.now());
      transcriptTurnsRef.current = [];

      try {
        await startMicrophone();
        await startSystemAudio();
        const response = await fetchRef.current("/api/meetings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        });
        if (!response.ok) throw new Error(await readErrorResponse(response));
        const payload = (await response.json()) as MeetingPayload;
        noteRef.current = payload.note;
        setNote(payload.note);
        setSummary(payload.note.summary || "");
        setStatus("recording");
        startTimer();
        return payload.note;
      } catch (startError) {
        await stopCapture();
        setStatus("idle");
        const message = startError instanceof Error ? startError.message : "Unable to start live meeting capture.";
        setError(message);
        throw new Error(message);
      }
    },
    [startMicrophone, startSystemAudio, startTimer, stopCapture],
  );

  const end = useCallback(async () => {
    const currentNote = noteRef.current;
    if (!currentNote) return null;
    setStatus("ending");
    await flushRealtimeInputs();
    await stopCapture();
    await persistTranscript();
    const response = await fetchRef.current(`/api/meetings/${encodeURIComponent(currentNote.id)}/end`, { method: "POST" });
    if (!response.ok) {
      const message = await readErrorResponse(response);
      setError(message);
      setStatus("ended");
      throw new Error(message);
    }
    const payload = (await response.json()) as MeetingPayload;
    noteRef.current = payload.note;
    setNote(payload.note);
    setSummary(payload.note.summary || "");
    setTranscript(payload.note.transcript || transcript);
    setStatus("ended");
    return payload.note;
  }, [flushRealtimeInputs, persistTranscript, stopCapture, transcript]);

  const reset = useCallback(() => {
    void stopCapture();
    noteRef.current = null;
    systemTurnBoundaryRef.current = initialLiveTurnBoundaryState(Date.now());
    transcriptTurnsRef.current = [];
    setStatus("idle");
    setNote(null);
    setElapsedSeconds(0);
    setTranscript("");
    setSummary("");
    setError(null);
  }, [stopCapture]);

  useEffect(() => {
    return () => {
      void stopCapture();
    };
  }, [stopCapture]);

  return {
    status,
    note,
    elapsedSeconds,
    audioLevel,
    transcript,
    summary,
    error,
    start,
    end,
    stopCapture,
    reset,
  };
}

async function requestRealtimeToken(fetchImpl: LiveMeetingFetch) {
  const response = await fetchImpl("/api/realtime/transcription-token", { method: "POST" });
  if (!response.ok) throw new Error(await readErrorResponse(response));
  const token = (await response.json()) as RealtimeTokenPayload;
  if (!token.value) throw new Error("Realtime transcription token is missing.");
  return token;
}

function startMicrophoneTurnMonitor(stream: MediaStream, channel: RTCDataChannel) {
  const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return () => undefined;

  const audioContext = new AudioContextCtor();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);
  const samples = new Uint8Array(analyser.fftSize);
  let boundaryState = initialLiveTurnBoundaryState(Date.now());
  const timer = window.setInterval(() => {
    analyser.getByteTimeDomainData(samples);
    const boundary = observeLiveTurnAudio(
      boundaryState,
      { now: Date.now(), level: byteTimeDomainLevel(samples) },
      liveTurnBoundaryOptions,
    );
    boundaryState = boundary.state;
    if (boundary.shouldCommit && channel.readyState === "open") channel.send(realtimeCommitMessage);
  }, microphoneTurnMonitorMs);

  return () => {
    window.clearInterval(timer);
    source.disconnect();
    void audioContext.close().catch(() => undefined);
  };
}

function openRealtimeTranscriptionSocket(token: RealtimeTokenPayload, onEvent: (event: RealtimeTranscriptEvent) => void) {
  return new Promise<WebSocket>((resolve, reject) => {
    const model = token.model || "gpt-realtime-whisper";
    const socket = new WebSocket("wss://api.openai.com/v1/realtime", [
      "realtime",
      `openai-insecure-api-key.${token.value}`,
    ]);
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "transcription",
            audio: {
              input: {
                format: {
                  type: "audio/pcm",
                  rate: 24000,
                },
                transcription: { model },
              },
            },
          },
        }),
      );
      resolve(socket);
    };
    socket.onerror = () => reject(new Error("OpenAI realtime system audio connection failed."));
    socket.onmessage = (message) => {
      try {
        onEvent(JSON.parse(String(message.data)) as RealtimeTranscriptEvent);
      } catch {
        // Ignore malformed realtime events.
      }
    };
  });
}

function readRealtimeErrorEvent(event: RealtimeTranscriptEvent) {
  const error = (event as { error?: unknown }).error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  if (typeof error === "string") return error;
  return "System audio realtime transcription failed.";
}

function closeRealtimeResources(
  peer: RTCPeerConnection | null,
  channel: RTCDataChannel | null,
  stream: MediaStream | null,
  socket: WebSocket | null,
) {
  if (channel && channel.readyState !== "closed") channel.close();
  peer?.close();
  stream?.getTracks().forEach((track) => track.stop());
  if (socket && socket.readyState !== WebSocket.CLOSED) socket.close();
}

async function readErrorResponse(response: Response) {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return response.statusText || `Request failed with status ${response.status}`;
}
