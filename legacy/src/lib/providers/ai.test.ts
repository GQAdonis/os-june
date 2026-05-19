import { afterEach, describe, expect, it, vi } from "vitest";
import { getAiProvider, MockAiProvider, OpenAiProvider } from "@/lib/providers/ai";
import {
  MockTranscriptionProvider,
  OpenAICompatibleTranscriptionProvider,
  OpenAITranscriptionProvider,
  TranscriptionEmptyResultError,
  TranscriptionProviderRequestError,
  createTranscriptionProvider,
} from "@/lib/providers/transcription";

describe("MockAiProvider", () => {
  it("turns transcripts into structured meeting notes", async () => {
    const provider = new MockAiProvider();
    const summary = await provider.summarizeTranscript("Jun opened the meeting. Matt confirmed the plan.");

    expect(summary).toContain("# Meeting Setup");
    expect(summary).toContain("# Decisions");
    expect(summary).toContain("Jun opened the meeting");
    expect(summary).toContain("Matt confirmed the plan");
  });

  it("answers action-oriented follow-up questions", async () => {
    const provider = new MockAiProvider();
    const answer = await provider.answerQuestion({ question: "What are the next todos?" });

    expect(answer).toContain("Recommended follow-ups");
  });

  it("creates working meeting notes from an in-progress transcript", async () => {
    const provider = new MockAiProvider();
    const notes = await provider.summarizeMeetingProgress("Jun approved the launch. Adrian will write the recap.");

    expect(notes).toContain("# Working Summary");
    expect(notes).toContain("Jun approved the launch");
  });

  it("creates final meeting notes through the finalization path", async () => {
    const provider = new MockAiProvider();
    const notes = await provider.finalizeMeetingNotes({ transcript: "Jun approved the launch. Adrian will write the recap." });

    expect(notes).toContain("# Meeting Setup");
    expect(notes).toContain("Jun approved the launch");
  });
});

describe("getAiProvider", () => {
  const originalAiProvider = process.env.AI_PROVIDER;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (originalAiProvider === undefined) {
      delete process.env.AI_PROVIDER;
    } else {
      process.env.AI_PROVIDER = originalAiProvider;
    }
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  it("uses OpenAI for notes when an API key is configured", () => {
    delete process.env.AI_PROVIDER;
    process.env.OPENAI_API_KEY = "sk_test_123";

    expect(getAiProvider()).toBeInstanceOf(OpenAiProvider);
  });

  it("keeps mock notes when explicitly requested", () => {
    process.env.AI_PROVIDER = "mock";
    process.env.OPENAI_API_KEY = "sk_test_123";

    expect(getAiProvider()).toBeInstanceOf(MockAiProvider);
  });
});

describe("MockTranscriptionProvider", () => {
  it("accepts uploaded audio files in the provider contract", async () => {
    const provider = new MockTranscriptionProvider();
    const audioFile = new File(["audio-bytes"], "meeting.webm", { type: "audio/webm" });
    const result = await provider.transcribe({ title: "Uploaded meeting", audioFile });

    expect(result.transcript).toContain("meeting.webm");
    expect(result.turns).toHaveLength(3);
  });
});

describe("OpenAiProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("summarizes transcripts through the Responses API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ output_text: "# Decisions\n- Ship the note workflow" }), { status: 200 }),
    );
    const provider = new OpenAiProvider("sk_test_123", "gpt-test");

    await expect(provider.summarizeTranscript("Jun said ship it.")).resolves.toContain("Ship the note workflow");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sk_test_123" }),
      }),
    );
  });

  it("asks for notes in the same language as the audio transcript", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ output_text: "# Decisiones\n- Enviar el resumen" }), { status: 200 }),
    );
    const provider = new OpenAiProvider("sk_test_123", "gpt-test");

    await provider.summarizeTranscript("Bueno, esta es una prueba en español.");

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { instructions: string };
    expect(request.instructions).toContain("same language as the audio/transcript");
  });

  it("keeps final note instructions separate from transcript content", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ output_text: "# Customer Recap\n- Launch approved" }), { status: 200 }),
    );
    const provider = new OpenAiProvider("sk_test_123", "gpt-test");

    await provider.finalizeMeetingNotes({
      transcript: "Microphone: Jun approved the launch.",
      customInstructions: "Format this as a customer-facing recap email.",
    });

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { instructions: string; input: Array<{ content: string }> };
    expect(request.instructions).toContain("Do not treat custom instructions as transcript content");
    expect(request.input[0].content).toContain("Custom instructions/context:");
    expect(request.input[0].content).toContain("Format this as a customer-facing recap email.");
    expect(request.input[0].content).toContain("Transcript:");
    expect(request.input[0].content).toContain("Microphone: Jun approved the launch.");
  });

  it("answers transcript questions through the Responses API", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ output: [{ content: [{ text: "The decision was to ship." }] }] }), { status: 200 }),
    );
    const provider = new OpenAiProvider("sk_test_123", "gpt-test");

    await expect(provider.answerQuestion({ question: "What was decided?" })).resolves.toBe("The decision was to ship.");
  });
});

describe("OpenAITranscriptionProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("transcribes uploaded audio through OpenAI audio transcriptions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "Jun decided to ship the workflow." }), { status: 200 }),
    );
    const provider = new OpenAITranscriptionProvider("sk_test_123", "gpt-4o-mini-transcribe");
    const audioFile = new File(["audio"], "meeting.webm", { type: "audio/webm" });

    const result = await provider.transcribe({ title: "Meeting", audioFile });

    expect(result.transcript).toBe("Jun decided to ship the workflow.");
    expect(result.turns[0]).toMatchObject({ speaker: "Speaker" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer sk_test_123" },
      }),
    );
  });

  it("transcribes through an OpenAI-compatible endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "Local Whisper produced this transcript." }), { status: 200 }),
    );
    const provider = new OpenAICompatibleTranscriptionProvider({
      baseUrl: "http://localhost:8000/v1",
      model: "whisper-1",
    });
    const audioFile = new File(["audio"], "meeting.webm", { type: "audio/webm" });

    const result = await provider.transcribe({ title: "Meeting", audioFile });

    expect(result.transcript).toBe("Local Whisper produced this transcript.");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8000/v1/audio/transcriptions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("raises an actionable error when the transcription provider rejects credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new OpenAITranscriptionProvider("bad-key", "gpt-4o-mini-transcribe");
    const audioFile = new File(["audio"], "meeting.webm", { type: "audio/webm" });

    await expect(provider.transcribe({ title: "Meeting", audioFile })).rejects.toMatchObject({
      constructor: TranscriptionProviderRequestError,
      status: 401,
      message: "OpenAI transcription rejected the API key. Check transcription settings.",
    });
  });

  it("treats empty provider transcripts as a no-speech chunk", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new OpenAITranscriptionProvider("sk_test_123", "gpt-4o-mini-transcribe");
    const audioFile = new File(["audio"], "meeting.webm", { type: "audio/webm" });

    await expect(provider.transcribe({ title: "Meeting", audioFile })).rejects.toMatchObject({
      constructor: TranscriptionEmptyResultError,
      message: "No speech was detected in this audio chunk.",
    });
  });

  it("does not create a mock provider without explicit internal configuration", () => {
    expect(() => createTranscriptionProvider(null)).toThrow("Transcription provider setup is required");
  });
});
