import { describe, expect, it, vi } from "vitest";
import {
  createRealtimeTranscriptionClientSecret,
  DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
  realtimeTranscriptionModelFromEnvironment,
  realtimeApiKeyFromTranscriptionConfig,
} from "@/lib/providers/realtime";

describe("realtime transcription provider", () => {
  it("requires OpenAI transcription settings", () => {
    expect(() => realtimeApiKeyFromTranscriptionConfig(null)).toThrow("OpenAI realtime transcription requires an API key");
    expect(() =>
      realtimeApiKeyFromTranscriptionConfig({
        provider: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
        model: "whisper-1",
        source: "environment",
      }),
    ).toThrow("Live quick notes require the OpenAI transcription provider");
  });

  it("creates a realtime transcription client secret", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ client_secret: { value: "eph_test", expires_at: 123 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const secret = await createRealtimeTranscriptionClientSecret({ apiKey: "sk_test_123", fetchImpl });

    expect(secret).toEqual({ value: "eph_test", expiresAt: 123, model: DEFAULT_REALTIME_TRANSCRIPTION_MODEL });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/client_secrets",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk_test_123" }),
      }),
    );
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.session).toMatchObject({
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: { model: DEFAULT_REALTIME_TRANSCRIPTION_MODEL },
        },
      },
    });
    expect(body.session.audio.input.turn_detection).toBeUndefined();
  });

  it("surfaces realtime provider error details", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Unsupported transcription model" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(createRealtimeTranscriptionClientSecret({ apiKey: "sk_test_123", fetchImpl })).rejects.toThrow(
      "OpenAI realtime transcription failed: Unsupported transcription model",
    );
  });

  it("uses the configured realtime transcription model", () => {
    const previousModel = process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL;
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";

    try {
      expect(realtimeTranscriptionModelFromEnvironment()).toBe("gpt-realtime-whisper");
    } finally {
      if (previousModel === undefined) {
        delete process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL;
      } else {
        process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL = previousModel;
      }
    }
  });

  it("falls back to realtime whisper when the environment contains a batch transcription model", () => {
    const previousModel = process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL;
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";

    try {
      expect(realtimeTranscriptionModelFromEnvironment()).toBe(DEFAULT_REALTIME_TRANSCRIPTION_MODEL);
    } finally {
      if (previousModel === undefined) {
        delete process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL;
      } else {
        process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL = previousModel;
      }
    }
  });
});
