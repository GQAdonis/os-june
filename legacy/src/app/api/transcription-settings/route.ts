import { z } from "zod";
import { prisma } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { errorJson, handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { getEnvironmentTranscriptionConfig, isTranscriptionConfigUsable, isUserTranscriptionProvider } from "@/lib/providers/transcription";

const saveSchema = z.object({
  provider: z.enum(["openai", "openai-compatible"]),
  model: z.string().trim().min(1).max(120).optional(),
  baseUrl: z.string().trim().url().optional().or(z.literal("")),
  apiKey: z.string().optional(),
});

export async function GET() {
  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    const settings = await prisma.transcriptionSettings.findUnique({ where: { workspaceId: workspace.id } });
    const environment = getEnvironmentTranscriptionConfig();

    return {
      configured: Boolean(settings || isTranscriptionConfigUsable(environment)),
      source: settings ? "workspace" : environment?.provider === "mock" ? "none" : environment ? "environment" : "none",
      settings: settings
        ? {
            provider: settings.provider,
            model: settings.model,
            baseUrl: settings.baseUrl,
            apiKeyConfigured: Boolean(settings.encryptedApiKey),
          }
        : environment && isUserTranscriptionProvider(environment.provider)
          ? {
              provider: environment.provider,
              model: environment.model,
              baseUrl: environment.baseUrl,
              apiKeyConfigured: Boolean(environment.apiKey),
            }
          : null,
    };
  });
}

export async function PUT(request: Request) {
  const body = saveSchema.safeParse(await request.json());
  if (!body.success) return errorJson("Invalid transcription settings", 422);

  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    const current = await prisma.transcriptionSettings.findUnique({ where: { workspaceId: workspace.id } });
    const apiKey = body.data.apiKey?.trim();

    if (body.data.provider === "openai" && !apiKey && !current?.encryptedApiKey) {
      throw new Error("OpenAI transcription requires an API key");
    }
    if (body.data.provider === "openai-compatible" && !body.data.baseUrl) {
      throw new Error("OpenAI-compatible transcription requires a base URL");
    }

    const settings = await prisma.transcriptionSettings.upsert({
      where: { workspaceId: workspace.id },
      create: {
        workspaceId: workspace.id,
        provider: body.data.provider,
        model: body.data.model || null,
        baseUrl: body.data.provider === "openai-compatible" ? body.data.baseUrl || null : null,
        encryptedApiKey: apiKey ? encryptSecret(apiKey) : null,
      },
      update: {
        provider: body.data.provider,
        model: body.data.model || null,
        baseUrl: body.data.provider === "openai-compatible" ? body.data.baseUrl || null : null,
        encryptedApiKey: apiKey ? encryptSecret(apiKey) : current?.encryptedApiKey || null,
      },
    });

    return {
      configured: true,
      source: "workspace",
      settings: {
        provider: settings.provider,
        model: settings.model,
        baseUrl: settings.baseUrl,
        apiKeyConfigured: Boolean(settings.encryptedApiKey),
      },
    };
  });
}
