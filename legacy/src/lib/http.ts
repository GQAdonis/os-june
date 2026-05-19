import { NextResponse } from "next/server";
import { EmptyMeetingTranscriptError } from "@/lib/meetings/service";
import {
  TranscriptionConfigurationError,
  TranscriptionEmptyResultError,
  TranscriptionProviderRequestError,
} from "@/lib/providers/transcription";

export function json<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function errorJson(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function handleRoute<T>(handler: () => Promise<T>) {
  try {
    return json(await handler());
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      return errorJson("Unauthorized", 401);
    }
    if (error instanceof TranscriptionConfigurationError) {
      return errorJson(error.message, 409);
    }
    if (error instanceof TranscriptionProviderRequestError) {
      return errorJson(error.message, 502);
    }
    if (error instanceof TranscriptionEmptyResultError) {
      return errorJson(error.message, 422);
    }
    if (error instanceof EmptyMeetingTranscriptError) {
      return errorJson(error.message, 422);
    }
    console.error(error);
    return errorJson(error instanceof Error ? error.message : "Unexpected error", 500);
  }
}
