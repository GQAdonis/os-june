import type {
  MeetingChunkUploadJob,
  MeetingChunkUploadResult,
  MeetingChunkUploadState,
  MeetingChunkUploadStatusUpdate,
} from "@/features/meetings/types";

type ChunkUploadFetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  json(): Promise<unknown>;
};

export type ChunkUploadFetch = (
  url: string,
  init: {
    method: "POST";
    body: FormData;
  },
) => Promise<ChunkUploadFetchResponse>;

export type ChunkUploadQueueOptions = {
  fetch: ChunkUploadFetch;
  onStatusChange?: (update: MeetingChunkUploadStatusUpdate) => void;
};

type MutableUploadState = MeetingChunkUploadState;

export function createChunkUploadQueue(options: ChunkUploadQueueOptions) {
  const jobs = new Map<string, MutableUploadState>();
  const pending: string[] = [];
  const idleWaiters: Array<() => void> = [];
  let running = false;

  function enqueue(job: MeetingChunkUploadJob) {
    const key = getChunkJobKey(job);
    if (jobs.has(key)) return key;

    const state: MutableUploadState = { key, job, status: "queued", attempts: 0 };
    jobs.set(key, state);
    pending.push(key);
    emit(state);
    runQueue();

    return key;
  }

  function retry(key: string) {
    const state = jobs.get(key);
    if (!state || state.status !== "failed") return false;

    state.status = "queued";
    state.error = undefined;
    state.result = undefined;
    pending.push(key);
    emit(state);
    runQueue();

    return true;
  }

  function getSnapshot() {
    return Array.from(jobs.values()).map(copyState);
  }

  function waitForIdle() {
    if (!running && pending.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => idleWaiters.push(resolve));
  }

  function runQueue() {
    if (running) return;
    running = true;

    void (async () => {
      while (pending.length > 0) {
        const key = pending.shift();
        if (!key) continue;

        const state = jobs.get(key);
        if (!state || state.status !== "queued") continue;

        await upload(state);
      }

      running = false;
      resolveIdleWaiters();
    })();
  }

  async function upload(state: MutableUploadState) {
    state.status = "uploading";
    state.attempts += 1;
    state.error = undefined;
    emit(state);

    try {
      state.result = await uploadChunk(state.job, options.fetch);
      state.status = "uploaded";
    } catch (error) {
      state.status = "failed";
      state.error = error instanceof Error ? error.message : "Chunk upload failed";
    }

    emit(state);
  }

  function emit(state: MutableUploadState) {
    options.onStatusChange?.(copyState(state));
  }

  function resolveIdleWaiters() {
    while (idleWaiters.length > 0) idleWaiters.shift()?.();
  }

  return {
    enqueue,
    retry,
    getSnapshot,
    waitForIdle,
  };
}

function getChunkJobKey(job: MeetingChunkUploadJob) {
  return `${job.noteId}:${job.source}:${job.index}`;
}

async function uploadChunk(job: MeetingChunkUploadJob, fetch: ChunkUploadFetch) {
  const body = new FormData();
  body.append("audio", job.blob, `${job.source}-${job.index}.${audioExtensionForBlob(job.blob)}`);
  body.append("source", job.source);
  body.append("index", String(job.index));
  body.append("startSec", String(job.startSec));
  body.append("endSec", String(job.endSec));

  const response = await fetch(`/api/meetings/${encodeURIComponent(job.noteId)}/chunks`, {
    method: "POST",
    body,
  });

  if (!response.ok) {
    throw new Error((await readChunkUploadError(response)) || response.statusText || `Chunk upload failed with status ${response.status}`);
  }

  return (await response.json()) as MeetingChunkUploadResult;
}

function audioExtensionForBlob(blob: Blob) {
  const mimeType = blob.type.toLowerCase().split(";")[0]?.trim();
  if (mimeType === "audio/wav" || mimeType === "audio/wave" || mimeType === "audio/x-wav") return "wav";
  if (mimeType === "audio/mpeg" || mimeType === "audio/mp3") return "mp3";
  if (mimeType === "audio/mp4" || mimeType === "audio/m4a" || mimeType === "audio/x-m4a") return "m4a";
  if (mimeType === "audio/ogg") return "ogg";
  if (mimeType === "audio/flac") return "flac";
  return "webm";
}

async function readChunkUploadError(response: ChunkUploadFetchResponse) {
  const payload = await response.json().catch(() => null);
  if (!payload || typeof payload !== "object") return "";
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  if (typeof (payload as { message?: unknown }).message === "string") return (payload as { message: string }).message;
  return "";
}

function copyState(state: MutableUploadState): MeetingChunkUploadState {
  return {
    ...state,
    job: { ...state.job },
  };
}
