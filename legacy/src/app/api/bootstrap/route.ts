import { handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { prisma } from "@/lib/db";
import { getEnvironmentTranscriptionConfig, isTranscriptionConfigUsable, isUserTranscriptionProvider } from "@/lib/providers/transcription";

export async function GET() {
  return handleRoute(async () => {
    const { user, workspace } = await getWorkspaceContext();
    const [spaces, notes, calendar, recentMessages, transcriptionSettings] = await Promise.all([
      prisma.space.findMany({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "asc" } }),
      prisma.note.findMany({
        where: { workspaceId: workspace.id },
        include: { shares: true },
        orderBy: { date: "desc" },
        take: 20,
      }),
      prisma.calendarConnection.findUnique({
        where: { workspaceId: workspace.id },
        include: { events: { orderBy: { startsAt: "asc" } } },
      }),
      prisma.chatMessage.findMany({
        where: { userId: user.id, noteId: null },
        orderBy: { createdAt: "asc" },
        take: 20,
      }),
      prisma.transcriptionSettings.findUnique({ where: { workspaceId: workspace.id } }),
    ]);
    const environmentTranscription = getEnvironmentTranscriptionConfig();

    return {
      user: { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl },
      workspace,
      spaces,
      notes,
      calendar,
      recentMessages,
      transcription: {
        configured: Boolean(transcriptionSettings || isTranscriptionConfigUsable(environmentTranscription)),
        source: transcriptionSettings
          ? "workspace"
          : environmentTranscription?.provider === "mock"
            ? "none"
            : environmentTranscription
              ? "environment"
              : "none",
        settings: transcriptionSettings
          ? {
              provider: transcriptionSettings.provider,
              model: transcriptionSettings.model,
              baseUrl: transcriptionSettings.baseUrl,
              apiKeyConfigured: Boolean(transcriptionSettings.encryptedApiKey),
            }
          : environmentTranscription && isUserTranscriptionProvider(environmentTranscription.provider)
            ? {
                provider: environmentTranscription.provider,
                model: environmentTranscription.model,
                baseUrl: environmentTranscription.baseUrl,
                apiKeyConfigured: Boolean(environmentTranscription.apiKey),
              }
            : null,
      },
    };
  });
}
