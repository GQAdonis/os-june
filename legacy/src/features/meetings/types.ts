export type MeetingChunkSource = "microphone" | "system";

export type MeetingChunkUploadStatus = "queued" | "uploading" | "uploaded" | "failed";

export type MeetingChunkUploadJob = {
  noteId: string;
  source: MeetingChunkSource;
  index: number;
  startSec: number;
  endSec: number;
  blob: Blob;
};

export type MeetingChunkUploadResult = {
  note: unknown;
  transcript: string;
  skipped?: boolean;
  reason?: string;
};

export type MeetingChunkUploadState = {
  key: string;
  job: MeetingChunkUploadJob;
  status: MeetingChunkUploadStatus;
  attempts: number;
  result?: MeetingChunkUploadResult;
  error?: string;
};

export type MeetingChunkUploadStatusUpdate = MeetingChunkUploadState;

export type EconomyMeetingStatus = "idle" | "starting" | "recording" | "ending" | "ended";

export type MeetingNote = {
  id: string;
  title: string;
  status?: string;
  transcript: string;
  summary: string;
};
