import {
  getWorkspaceTranscriptionConfig,
  TranscriptionConfigurationError,
  TranscriptionProviderRequestError,
} from "@/lib/providers/transcription";

export const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = "gpt-realtime-whisper";
const SUPPORTED_REALTIME_TRANSCRIPTION_MODELS = new Set([DEFAULT_REALTIME_TRANSCRIPTION_MODEL]);

type RealtimeClientSecretResponse = {
  value?: string;
  expires_at?: number;
  client_secret?: {
    value?: string;
    expires_at?: number;
  };
};

export type RealtimeTranscriptionClientSecret = {
  value: string;
  expiresAt?: number;
  model: string;
};

export function realtimeApiKeyFromTranscriptionConfig(config: Awaited<ReturnType<typeof getWorkspaceTranscriptionConfig>>) {
  if (!config) throw new TranscriptionConfigurationError("OpenAI realtime transcription requires an API key");
  if (config.provider !== "openai") {
    throw new TranscriptionConfigurationError("Live quick notes require the OpenAI transcription provider");
  }
  if (!config.apiKey) throw new TranscriptionConfigurationError("OpenAI realtime transcription requires an API key");
  return config.apiKey;
}

export async function createRealtimeTranscriptionClientSecret({
  apiKey,
  model = DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
  fetchImpl = fetch,
}: {
  apiKey: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Promise<RealtimeTranscriptionClientSecret> {
  const response = await fetchImpl("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
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
  });

  if (!response.ok) {
    throw new TranscriptionProviderRequestError(
      await realtimeProviderErrorMessage(response),
      response.status,
    );
  }

  const payload = (await response.json()) as RealtimeClientSecretResponse;
  const value = payload.client_secret?.value || payload.value;
  if (!value) throw new TranscriptionConfigurationError("OpenAI realtime transcription did not return a client secret");

  return {
    value,
    expiresAt: payload.client_secret?.expires_at || payload.expires_at,
    model,
  };
}

export async function createWorkspaceRealtimeTranscriptionClientSecret(workspaceId: string) {
  const config = await getWorkspaceTranscriptionConfig(workspaceId);
  return createRealtimeTranscriptionClientSecret({
    apiKey: realtimeApiKeyFromTranscriptionConfig(config),
    model: realtimeTranscriptionModelFromEnvironment(),
  });
}

export function realtimeTranscriptionModelFromEnvironment() {
  const model = process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim();
  if (!model) return DEFAULT_REALTIME_TRANSCRIPTION_MODEL;
  if (!SUPPORTED_REALTIME_TRANSCRIPTION_MODELS.has(model)) return DEFAULT_REALTIME_TRANSCRIPTION_MODEL;
  return model;
}

async function realtimeProviderErrorMessage(response: Response) {
  const detail = await readRealtimeProviderErrorDetail(response);
  return detail ? `OpenAI realtime transcription failed: ${detail}` : `OpenAI realtime transcription failed with status ${response.status}`;
}

async function readRealtimeProviderErrorDetail(response: Response) {
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
