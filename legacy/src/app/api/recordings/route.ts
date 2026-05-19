import { z } from "zod";
import { prisma } from "@/lib/db";
import { errorJson, handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { getAiProvider } from "@/lib/providers/ai";
import { getWorkspaceTranscriptionProvider, transcriptionFromText } from "@/lib/providers/transcription";

const schema = z.object({
  title: z.string().min(1).max(120).default("Short recording"),
  audioText: z.string().optional(),
});

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  let payload: { title: string; audioText?: string; audioFile?: File };

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const audio = form.get("audio");
    const body = schema.safeParse({
      title: form.get("title") || "Short recording",
      audioText: form.get("audioText") || undefined,
    });
    if (!body.success) return errorJson("Invalid recording payload", 422);
    payload = {
      ...body.data,
      audioFile: audio instanceof File ? audio : undefined,
    };
  } else {
    const body = schema.safeParse(await request.json());
    if (!body.success) return errorJson("Invalid recording payload", 422);
    payload = body.data;
  }

  return handleRoute(async () => {
    const { user, workspace } = await getWorkspaceContext();
    const space = await prisma.space.findFirst({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "asc" } });
    if (!space) throw new Error("No space available");

    const transcription =
      payload.audioFile
        ? await (await getWorkspaceTranscriptionProvider(workspace.id)).transcribe(payload)
        : transcriptionFromText(payload.audioText || "");
    const summary = await getAiProvider().summarizeTranscript(transcription.transcript);
    const note = await prisma.note.create({
      data: {
        title: payload.title,
        status: "READY",
        visibility: "PRIVATE",
        date: new Date(),
        summary,
        transcript: transcription.transcript,
        workspaceId: workspace.id,
        spaceId: space.id,
        ownerId: user.id,
        turns: { create: transcription.turns },
      },
      include: { turns: true, shares: true },
    });

    return { note };
  });
}
