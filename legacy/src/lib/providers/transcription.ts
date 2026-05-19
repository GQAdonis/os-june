import { prisma } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";

export const OPENAI_TRANSCRIPTION_MODELS = [
  "gpt-4o-mini-transcribe",
  "gpt-4o-transcribe",
  "gpt-4o-transcribe-diarize",
  "whisper-1",
] as const;

export type UserTranscriptionProvider = "openai" | "openai-compatible";
export type InternalTranscriptionProvider = UserTranscriptionProvider | "mock";

export type TranscriptionResult = {
  transcript: string;
  turns: Array<{ speaker: string; text: string; startSec: number; endSec: number }>;
};

export type TranscriptionInput = {
  title: string;
  audioText?: string;
  audioFile?: File;
};

export type TranscriptionConfig = {
  provider: InternalTranscriptionProvider;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  source: "workspace" | "environment" | "internal";
};

export interface TranscriptionProvider {
  transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export class TranscriptionConfigurationError extends Error {
  constructor(message = "Transcription provider setup is required") {
    super(message);
    this.name = "TranscriptionConfigurationError";
  }
}

export class TranscriptionProviderRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TranscriptionProviderRequestError";
  }
}

export class TranscriptionEmptyResultError extends Error {
  constructor(message = "No speech was detected in this audio chunk.") {
    super(message);
    this.name = "TranscriptionEmptyResultError";
  }
}

export class MockTranscriptionProvider implements TranscriptionProvider {
  async transcribe({ title, audioText, audioFile }: TranscriptionInput) {
    const audioDetail = audioFile ? ` Uploaded audio file ${audioFile.name || "recording.webm"} was received.` : "";
    const seed =
      audioText?.trim() ||
      `Jun opened ${title}. Matt confirmed the plan. Adrian asked for a written follow-up.${audioDetail}`;
    return {
      transcript: seed,
      turns: [
        { speaker: "Jun", text: seed.split(".")[0] || "Meeting started.", startSec: 0, endSec: 12 },
        { speaker: "Matt", text: "Confirmed the plan and timing.", startSec: 13, endSec: 22 },
        { speaker: "Adrian", text: "Asked for a written follow-up.", startSec: 23, endSec: 31 },
      ],
    };
  }
}

type OpenAITranscriptionResponse = {
  text?: string;
  segments?: Array<{
    speaker?: string;
    text?: string;
    start?: number;
    end?: number;
  }>;
};

export class OpenAICompatibleTranscriptionProvider implements TranscriptionProvider {
  constructor(
    private readonly config: {
      baseUrl: string;
      apiKey?: string;
      model: string;
      providerName?: string;
      allowDiarizedJson?: boolean;
    },
  ) {}

  async transcribe(input: TranscriptionInput) {
    if (!input.audioFile) {
      throw new Error("An audio file is required for transcription");
    }

    const form = new FormData();
    form.set("model", this.config.model);
    form.set("file", input.audioFile, input.audioFile.name || "recording.webm");
    form.set("response_format", this.config.allowDiarizedJson && this.config.model.includes("diarize") ? "diarized_json" : "json");

    const response = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : undefined,
      body: form,
    });
    if (!response.ok) {
      const providerName = this.config.providerName || "Transcription";
      throw new TranscriptionProviderRequestError(
        await transcriptionProviderErrorMessage(response, providerName),
        response.status,
      );
    }

    return transcriptionFromOpenAIResponse(await response.json());
  }
}

export class OpenAITranscriptionProvider extends OpenAICompatibleTranscriptionProvider {
  constructor(apiKey?: string, model = "gpt-4o-mini-transcribe") {
    if (!apiKey) {
      throw new TranscriptionConfigurationError("OpenAI transcription requires an API key");
    }
    super({ baseUrl: "https://api.openai.com/v1", apiKey, model, providerName: "OpenAI transcription", allowDiarizedJson: true });
  }
}

export function transcriptionFromText(text: string, speaker = "Speaker"): TranscriptionResult {
  const transcript = text.trim();
  return {
    transcript,
    turns: transcript ? [{ speaker, text: transcript, startSec: 0, endSec: 0 }] : [],
  };
}

function transcriptionFromOpenAIResponse(payload: unknown): TranscriptionResult {
  const response = payload as OpenAITranscriptionResponse;
  const transcript = response.text?.trim();
  if (!transcript) {
    throw new TranscriptionEmptyResultError();
  }

  const turns =
    response.segments?.length
      ? response.segments
          .filter((segment) => segment.text?.trim())
          .map((segment, index) => ({
            speaker: segment.speaker || `Speaker ${index + 1}`,
            text: segment.text?.trim() || "",
            startSec: Math.round(segment.start || 0),
            endSec: Math.round(segment.end || segment.start || 0),
          }))
      : [{ speaker: "Speaker", text: transcript, startSec: 0, endSec: 0 }];

  return { transcript, turns };
}

async function transcriptionProviderErrorMessage(response: Response, providerName: string) {
  const detail = await readProviderErrorDetail(response);
  if (response.status === 401 || response.status === 403) {
    return `${providerName} rejected the API key. Check transcription settings.`;
  }
  return detail ? `${providerName} failed: ${detail}` : `${providerName} failed with status ${response.status}`;
}

async function readProviderErrorDetail(response: Response) {
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

export function isUserTranscriptionProvider(value: unknown): value is UserTranscriptionProvider {
  return value === "openai" || value === "openai-compatible";
}

export function isTranscriptionConfigUsable(config: TranscriptionConfig | null) {
  if (!config || config.provider === "mock") return false;
  if (config.provider === "openai") return Boolean(config.apiKey);
  if (config.provider === "openai-compatible") return Boolean(config.baseUrl);
  return false;
}

export function getEnvironmentTranscriptionConfig(): TranscriptionConfig | null {
  const provider =
    process.env.TRANSCRIPTION_PROVIDER ||
    (process.env.OPENAI_COMPATIBLE_TRANSCRIPTION_BASE_URL || process.env.TRANSCRIPTION_BASE_URL
      ? "openai-compatible"
      : process.env.OPENAI_API_KEY
        ? "openai"
        : undefined);

  if (provider === "openai") {
    return {
      provider,
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe",
      source: "environment",
    };
  }

  if (provider === "openai-compatible") {
    return {
      provider,
      baseUrl: process.env.OPENAI_COMPATIBLE_TRANSCRIPTION_BASE_URL || process.env.TRANSCRIPTION_BASE_URL,
      apiKey: process.env.OPENAI_COMPATIBLE_TRANSCRIPTION_API_KEY || process.env.TRANSCRIPTION_API_KEY,
      model: process.env.OPENAI_COMPATIBLE_TRANSCRIPTION_MODEL || process.env.TRANSCRIPTION_MODEL || "whisper-1",
      source: "environment",
    };
  }

  if (provider === "mock" && process.env.NODE_ENV !== "production" && process.env.INTERNAL_TRANSCRIPTION_PROVIDER === "mock") {
    return { provider: "mock", source: "internal" };
  }

  return null;
}

export async function getWorkspaceTranscriptionConfig(workspaceId: string): Promise<TranscriptionConfig | null> {
  const settings = await prisma.transcriptionSettings.findUnique({ where: { workspaceId } });
  if (settings) {
    if (!isUserTranscriptionProvider(settings.provider)) {
      throw new TranscriptionConfigurationError("Saved transcription provider is invalid");
    }
    return {
      provider: settings.provider,
      model: settings.model || undefined,
      baseUrl: settings.baseUrl || undefined,
      apiKey: settings.encryptedApiKey ? decryptSecret(settings.encryptedApiKey) : undefined,
      source: "workspace",
    };
  }

  return getEnvironmentTranscriptionConfig();
}

export function createTranscriptionProvider(config: TranscriptionConfig | null): TranscriptionProvider {
  if (!config) {
    throw new TranscriptionConfigurationError();
  }

  if (config.provider === "openai") {
    return new OpenAITranscriptionProvider(config.apiKey, config.model || "gpt-4o-mini-transcribe");
  }

  if (config.provider === "openai-compatible") {
    if (!config.baseUrl) {
      throw new TranscriptionConfigurationError("OpenAI-compatible transcription requires a base URL");
    }
    return new OpenAICompatibleTranscriptionProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model || "whisper-1",
      providerName: "OpenAI-compatible transcription",
    });
  }

  if (config.provider === "mock" && config.source === "internal" && process.env.NODE_ENV !== "production") {
    return new MockTranscriptionProvider();
  }

  throw new TranscriptionConfigurationError();
}

export async function getWorkspaceTranscriptionProvider(workspaceId: string) {
  return createTranscriptionProvider(await getWorkspaceTranscriptionConfig(workspaceId));
}

export async function getTranscriptionProvider(): Promise<TranscriptionProvider> {
  return createTranscriptionProvider(getEnvironmentTranscriptionConfig());
}
