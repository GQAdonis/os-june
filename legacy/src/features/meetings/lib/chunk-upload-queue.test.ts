import { describe, expect, it, vi } from "vitest";
import { createChunkUploadQueue } from "@/features/meetings/lib/chunk-upload-queue";
import type { MeetingChunkUploadJob, MeetingChunkUploadStatusUpdate } from "@/features/meetings/types";

function chunkJob(index: number): MeetingChunkUploadJob {
  return {
    noteId: "note-1",
    source: "microphone",
    index,
    startSec: index * 20,
    endSec: index * 20 + 20,
    blob: new Blob([`audio-${index}`], { type: "audio/webm" }),
  };
}

function okChunkResponse(transcript: string) {
  return new Response(JSON.stringify({ note: { id: "note-1" }, transcript }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createChunkUploadQueue", () => {
  it("uploads chunks sequentially as multipart form data and reports status transitions", async () => {
    let finishFirstUpload!: () => void;
    const firstUploadStarted = new Promise<void>((resolve) => {
      finishFirstUpload = resolve;
    });
    const requests: Array<{ url: string; body: FormData }> = [];
    const updates: MeetingChunkUploadStatusUpdate[] = [];
    const fetch = vi.fn(async (url: string, init: { body?: BodyInit | null }) => {
      requests.push({ url, body: init.body as FormData });
      if (requests.length === 1) await firstUploadStarted;
      return okChunkResponse(`chunk ${requests.length}`);
    });
    const queue = createChunkUploadQueue({ fetch, onStatusChange: (update) => updates.push(update) });

    queue.enqueue(chunkJob(0));
    queue.enqueue(chunkJob(1));
    await vi.waitFor(() => expect(requests).toHaveLength(1));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(requests[0]?.url).toBe("/api/meetings/note-1/chunks");
    expect(requests[0]?.body.get("source")).toBe("microphone");
    expect(requests[0]?.body.get("index")).toBe("0");
    expect(requests[0]?.body.get("startSec")).toBe("0");
    expect(requests[0]?.body.get("endSec")).toBe("20");
    expect(requests[0]?.body.get("audio")).toBeInstanceOf(Blob);

    finishFirstUpload();
    await queue.waitForIdle();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requests[1]?.body.get("index")).toBe("1");
    expect(updates.map((update) => [update.job.index, update.status])).toEqual([
      [0, "queued"],
      [0, "uploading"],
      [1, "queued"],
      [0, "uploaded"],
      [1, "uploading"],
      [1, "uploaded"],
    ]);
  });

  it("keeps failed jobs retryable without blocking later chunks or duplicating retries", async () => {
    const updates: MeetingChunkUploadStatusUpdate[] = [];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("failed", { status: 503 }))
      .mockResolvedValueOnce(okChunkResponse("later chunk"))
      .mockResolvedValueOnce(okChunkResponse("retried chunk"));
    const queue = createChunkUploadQueue({ fetch, onStatusChange: (update) => updates.push(update) });

    const failedKey = queue.enqueue(chunkJob(0));
    queue.enqueue(chunkJob(1));
    await queue.waitForIdle();

    expect(queue.getSnapshot()).toMatchObject([
      { key: failedKey, status: "failed", attempts: 1 },
      { status: "uploaded", attempts: 1 },
    ]);

    expect(queue.retry(failedKey)).toBe(true);
    expect(queue.retry(failedKey)).toBe(false);
    await queue.waitForIdle();

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(queue.getSnapshot()).toMatchObject([
      { key: failedKey, status: "uploaded", attempts: 2 },
      { status: "uploaded", attempts: 1 },
    ]);
    expect(updates.map((update) => [update.job.index, update.status])).toEqual([
      [0, "queued"],
      [0, "uploading"],
      [1, "queued"],
      [0, "failed"],
      [1, "uploading"],
      [1, "uploaded"],
      [0, "queued"],
      [0, "uploading"],
      [0, "uploaded"],
    ]);
  });

  it("keeps the server error body when a chunk upload fails", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "OpenAI transcription rejected the API key. Check transcription settings." }), {
        status: 502,
        statusText: "Bad Gateway",
        headers: { "content-type": "application/json" },
      }),
    );
    const queue = createChunkUploadQueue({ fetch });

    queue.enqueue(chunkJob(0));
    await queue.waitForIdle();

    expect(queue.getSnapshot()[0]).toMatchObject({
      status: "failed",
      error: "OpenAI transcription rejected the API key. Check transcription settings.",
    });
  });

  it("uses an audio filename extension that matches the blob type", async () => {
    const requests: Array<{ body: FormData }> = [];
    const fetch = vi.fn(async (_url: string, init: { body?: BodyInit | null }) => {
      requests.push({ body: init.body as FormData });
      return okChunkResponse("system audio");
    });
    const queue = createChunkUploadQueue({ fetch });

    queue.enqueue({
      ...chunkJob(0),
      source: "system",
      blob: new Blob(["audio"], { type: "audio/wav" }),
    });
    await queue.waitForIdle();

    const audio = requests[0]?.body.get("audio");
    expect(audio).toBeInstanceOf(File);
    expect((audio as File).name).toBe("system-0.wav");
  });
});
