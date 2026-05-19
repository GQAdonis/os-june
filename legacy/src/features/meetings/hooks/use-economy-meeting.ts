"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createChunkUploadQueue, type ChunkUploadFetch } from "@/features/meetings/lib/chunk-upload-queue";
import type { EconomyMeetingStatus, MeetingNote } from "@/features/meetings/types";
import type { MeetingChunkSource } from "@/features/meetings/types";

type EconomyMeetingFetch = (url: string, init?: RequestInit) => Promise<Response>;

type UseEconomyMeetingOptions = {
  fetch?: EconomyMeetingFetch;
  captureMicrophone?: boolean;
  chunkMs?: number;
};

type MeetingPayload = {
  note: MeetingNote;
};

type ExternalChunkInput = {
  source: MeetingChunkSource;
  blob: Blob;
  startSec: number;
  endSec: number;
};

export function useEconomyMeeting({
  fetch: fetchOption,
  captureMicrophone = true,
  chunkMs = 25_000,
}: UseEconomyMeetingOptions = {}) {
  const fetchRef = useRef<EconomyMeetingFetch>(fetchOption || ((url, init) => window.fetch(url, init)));
  const [status, setStatus] = useState<EconomyMeetingStatus>("idle");
  const [note, setNote] = useState<MeetingNote | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [audioLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const queueRef = useRef<ReturnType<typeof createChunkUploadQueue> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const microphoneChunkTimerRef = useRef<number | null>(null);
  const microphoneActiveRef = useRef(false);
  const microphoneRotationRef = useRef<Promise<void>>(Promise.resolve());
  const startedAtRef = useRef<number>(0);
  const chunkIndexRef = useRef(0);
  const uploadedChunkCountRef = useRef(0);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const startTimer = useCallback(() => {
    stopTimer();
    timerRef.current = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 250);
  }, [stopTimer]);

  const stopMicrophone = useCallback(async () => {
    microphoneActiveRef.current = false;
    if (microphoneChunkTimerRef.current) {
      window.clearInterval(microphoneChunkTimerRef.current);
      microphoneChunkTimerRef.current = null;
    }
    await microphoneRotationRef.current.catch(() => undefined);
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      await stopRecorder(recorder);
    }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const refreshInsights = useCallback(async (noteId: string) => {
    try {
      const response = await fetchRef.current(`/api/meetings/${encodeURIComponent(noteId)}/insights`, { method: "POST" });
      if (!response.ok) return;
      const payload = (await response.json()) as MeetingPayload;
      setNote(payload.note);
    } catch {
      // Working notes are opportunistic; failed refreshes should not stop capture.
    }
  }, []);

  const getQueue = useCallback(() => {
    if (!queueRef.current) {
      queueRef.current = createChunkUploadQueue({
        fetch: fetchRef.current as ChunkUploadFetch,
        onStatusChange: (update) => {
          if (update.status === "failed") {
            setError(update.error || "Audio chunk transcription failed.");
            return;
          }
          if (update.status !== "uploaded" || !isMeetingPayload(update.result)) return;
          uploadedChunkCountRef.current += 1;
          setNote(update.result.note);
          if (uploadedChunkCountRef.current % 4 === 0) void refreshInsights(update.job.noteId);
        },
      });
    }
    return queueRef.current;
  }, [refreshInsights]);

  const startMicrophone = useCallback(
    async (noteId: string) => {
      if (!captureMicrophone || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : undefined;
      microphoneActiveRef.current = true;

      const startRecorder = () => {
        if (!microphoneActiveRef.current) return;
        const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorderRef.current = recorder;
        const startedAt = Date.now();
        recorder.ondataavailable = (event) => {
          if (!event.data.size) return;
          const index = chunkIndexRef.current;
          chunkIndexRef.current += 1;
          const startSec = Math.max(0, Math.round((startedAt - startedAtRef.current) / 1000));
          const endSec = Math.max(startSec + 1, Math.round((Date.now() - startedAtRef.current) / 1000));
          getQueue().enqueue({
            noteId,
            source: "microphone",
            index,
            startSec,
            endSec,
            blob: event.data,
          });
        };
        recorder.onstop = () => {
          if (recorderRef.current === recorder) recorderRef.current = null;
        };
        recorder.start();
      };

      startRecorder();
      microphoneChunkTimerRef.current = window.setInterval(() => {
        microphoneRotationRef.current = microphoneRotationRef.current.then(async () => {
          const recorder = recorderRef.current;
          if (recorder?.state === "recording") await stopRecorder(recorder);
          if (microphoneActiveRef.current) startRecorder();
        });
      }, chunkMs);
    },
    [captureMicrophone, chunkMs, getQueue],
  );

  const start = useCallback(
    async (title = "New meeting") => {
      setStatus("starting");
      setError(null);
      setElapsedSeconds(0);
      chunkIndexRef.current = 0;
      uploadedChunkCountRef.current = 0;
      const response = await fetchRef.current("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!response.ok) {
        setStatus("idle");
        throw new Error(await readErrorResponse(response));
      }
      const payload = (await response.json()) as MeetingPayload;
      setNote(payload.note);
      setStatus("recording");
      startedAtRef.current = Date.now();
      startTimer();

      try {
        await startMicrophone(payload.note.id);
      } catch {
        setError("Microphone capture is unavailable. The meeting note was created without live chunks.");
      }

      return payload.note;
    },
    [startMicrophone, startTimer],
  );

  const resumeCapture = useCallback(async () => {
    if (!note) return null;
    setError(null);
    setStatus("recording");
    startTimer();
    if (!microphoneActiveRef.current) {
      try {
        await startMicrophone(note.id);
      } catch {
        setError("Microphone capture is unavailable. The meeting note was not resumed.");
      }
    }
    return note;
  }, [note, startMicrophone, startTimer]);

  const stopCapture = useCallback(async () => {
    stopTimer();
    await stopMicrophone();
    await queueRef.current?.waitForIdle();
  }, [stopMicrophone, stopTimer]);

  const end = useCallback(async (supplementalText?: string) => {
    if (!note) return null;
    setStatus("ending");
    await stopCapture();
    const init: RequestInit = supplementalText?.trim()
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ supplementalText: supplementalText.trim() }),
        }
      : { method: "POST" };
    const response = await fetchRef.current(`/api/meetings/${encodeURIComponent(note.id)}/end`, init);
    if (!response.ok) {
      setStatus("recording");
      throw new Error(await readErrorResponse(response));
    }
    const payload = (await response.json()) as MeetingPayload;
    setNote(payload.note);
    setStatus("ended");
    return payload.note;
  }, [note, stopCapture]);

  const uploadChunk = useCallback(
    async (chunk: ExternalChunkInput) => {
      if (!note) throw new Error("Meeting note is required before uploading chunks");
      const index = chunkIndexRef.current;
      chunkIndexRef.current += 1;
      const queue = getQueue();
      const key = queue.enqueue({
        noteId: note.id,
        source: chunk.source,
        index,
        startSec: chunk.startSec,
        endSec: chunk.endSec,
        blob: chunk.blob,
      });
      await queue.waitForIdle();
      const failed = queue.getSnapshot().find((state) => state.key === key && state.status === "failed");
      if (failed) {
        const message = failed.error || "Audio chunk transcription failed.";
        setError(message);
        throw new Error(message);
      }
    },
    [getQueue, note],
  );

  useEffect(() => {
    return () => {
      stopTimer();
      void stopMicrophone();
    };
  }, [stopMicrophone, stopTimer]);

  return {
    status,
    note,
    elapsedSeconds,
    audioLevel,
    transcript: note?.transcript || "",
    summary: note?.summary || "",
    error,
    start,
    resumeCapture,
    end,
    stopCapture,
    uploadChunk,
  };
}

function isMeetingPayload(value: unknown): value is MeetingPayload {
  if (!value || typeof value !== "object" || !("note" in value)) return false;
  const note = (value as { note?: unknown }).note;
  return Boolean(note && typeof note === "object" && "id" in note);
}

async function readErrorResponse(response: Response) {
  const payload = await response.json().catch(() => null);
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
      return (error as { message: string }).message;
    }
  }
  return response.statusText || `Request failed with status ${response.status}`;
}

function stopRecorder(recorder: MediaRecorder) {
  return new Promise<void>((resolve) => {
    const previousOnStop = recorder.onstop;
    recorder.onstop = (event) => {
      previousOnStop?.call(recorder, event);
      resolve();
    };
    try {
      recorder.stop();
    } catch {
      resolve();
    }
  });
}
