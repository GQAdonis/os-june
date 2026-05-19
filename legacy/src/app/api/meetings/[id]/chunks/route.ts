import { z } from "zod";
import { errorJson, handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { getWorkspaceTranscriptionProvider, TranscriptionEmptyResultError } from "@/lib/providers/transcription";
import { getMeetingNote, recordMeetingChunk } from "@/lib/meetings/service";

const chunkMetadataSchema = z.object({
  source: z.enum(["microphone", "system"]).default("microphone"),
  index: z.coerce.number().int().min(0),
  startSec: z.coerce.number().int().min(0),
  endSec: z.coerce.number().int().min(0),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await request.formData();
  const audio = form.get("audio");
  if (!(audio instanceof File)) return errorJson("Audio file is required", 422);

  const metadata = chunkMetadataSchema.safeParse({
    source: form.get("source") || "microphone",
    index: form.get("index"),
    startSec: form.get("startSec"),
    endSec: form.get("endSec"),
  });
  if (!metadata.success) return errorJson("Invalid chunk payload", 422);

  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    const provider = await getWorkspaceTranscriptionProvider(workspace.id);
    const transcription = await provider.transcribe({ title: "Meeting chunk", audioFile: audio }).catch(async (error) => {
      if (!(error instanceof TranscriptionEmptyResultError)) throw error;
      const note = await getMeetingNote({ noteId: id, workspaceId: workspace.id });
      return { skipped: true as const, note, transcript: "", reason: error.message };
    });
    if ("skipped" in transcription) return transcription;

    const note = await recordMeetingChunk({
      noteId: id,
      workspaceId: workspace.id,
      ...metadata.data,
      text: transcription.transcript,
    });

    return { note, transcript: transcription.transcript };
  });
}
