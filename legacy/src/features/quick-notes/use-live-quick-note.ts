"use client";

import { useCallback, useRef, useState } from "react";
import type { MeetingNote } from "@/features/meetings/types";
import {
  applyRealtimeTranscriptEvent,
  emptyRealtimeTranscriptState,
  realtimeTranscriptStateFromText,
  realtimeTranscriptText,
  type RealtimeTranscriptEvent,
  type RealtimeTranscriptState,
} from "@/features/quick-notes/realtime-transcript";

type LiveQuickNoteFetch = (url: string, init?: RequestInit) => Promise<Response>;

type RealtimeTokenPayload = {
  value: string;
};

type MeetingPayload = {
  note: MeetingNote;
};

type LiveQuickNoteStatus = "idle" | "connecting" | "recording" | "stopping";

export function useLiveQuickNote({ fetch: fetchOption }: { fetch?: LiveQuickNoteFetch } = {}) {
  const fetchRef = useRef<LiveQuickNoteFetch>(fetchOption || ((url, init) => window.fetch(url, init)));
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const noteIdRef = useRef<string | null>(null);
  const transcriptStateRef = useRef<RealtimeTranscriptState>(emptyRealtimeTranscriptState());
  const [status, setStatus] = useState<LiveQuickNoteStatus>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const applyEvent = useCallback((event: RealtimeTranscriptEvent) => {
    transcriptStateRef.current = applyRealtimeTranscriptEvent(transcriptStateRef.current, event);
    setTranscript(realtimeTranscriptText(transcriptStateRef.current));
  }, []);

  const persistTranscript = useCallback(async () => {
    const noteId = noteIdRef.current;
    if (!noteId) return null;
    const currentTranscript = realtimeTranscriptText(transcriptStateRef.current);
    const response = await fetchRef.current(`/api/meetings/${encodeURIComponent(noteId)}/live-transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: currentTranscript }),
    });
    if (!response.ok) throw new Error(await readErrorResponse(response));
    const payload = (await response.json()) as MeetingPayload;
    return payload.note;
  }, []);

  const start = useCallback(
    async (noteId: string, initialTranscript = "") => {
      setStatus("connecting");
      setError(null);
      noteIdRef.current = noteId;
      transcriptStateRef.current = realtimeTranscriptStateFromText(initialTranscript);
      setTranscript(realtimeTranscriptText(transcriptStateRef.current));

      try {
        const tokenResponse = await fetchRef.current("/api/realtime/transcription-token", { method: "POST" });
        if (!tokenResponse.ok) throw new Error(await readErrorResponse(tokenResponse));
        const token = (await tokenResponse.json()) as RealtimeTokenPayload;
        if (!token.value) throw new Error("Realtime transcription token is missing.");

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const peer = new RTCPeerConnection();
        const channel = peer.createDataChannel("oai-events");
        stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream));
        channel.onmessage = (message) => {
          try {
            applyEvent(JSON.parse(String(message.data)) as RealtimeTranscriptEvent);
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
        if (!sdpResponse.ok) throw new Error(`OpenAI realtime connection failed: ${sdpResponse.status}`);
        await peer.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });

        peerRef.current = peer;
        channelRef.current = channel;
        streamRef.current = stream;
        setStatus("recording");
      } catch (startError) {
        closeLiveResources(peerRef.current, channelRef.current, streamRef.current);
        peerRef.current = null;
        channelRef.current = null;
        streamRef.current = null;
        setStatus("idle");
        const message = startError instanceof Error ? startError.message : "Unable to start live transcription.";
        setError(message);
        throw new Error(message);
      }
    },
    [applyEvent],
  );

  const stop = useCallback(async () => {
    setStatus("stopping");
    closeLiveResources(peerRef.current, channelRef.current, streamRef.current);
    peerRef.current = null;
    channelRef.current = null;
    streamRef.current = null;
    try {
      return await persistTranscript();
    } finally {
      setStatus("idle");
    }
  }, [persistTranscript]);

  const reset = useCallback(() => {
    closeLiveResources(peerRef.current, channelRef.current, streamRef.current);
    peerRef.current = null;
    channelRef.current = null;
    streamRef.current = null;
    noteIdRef.current = null;
    transcriptStateRef.current = emptyRealtimeTranscriptState();
    setTranscript("");
    setError(null);
    setStatus("idle");
  }, []);

  return {
    status,
    transcript,
    error,
    start,
    stop,
    reset,
  };
}

function closeLiveResources(peer: RTCPeerConnection | null, channel: RTCDataChannel | null, stream: MediaStream | null) {
  if (channel && channel.readyState !== "closed") channel.close();
  peer?.close();
  stream?.getTracks().forEach((track) => track.stop());
}

async function readErrorResponse(response: Response) {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return response.statusText || `Request failed with status ${response.status}`;
}
