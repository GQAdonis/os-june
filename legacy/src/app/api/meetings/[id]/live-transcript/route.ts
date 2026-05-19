import { z } from "zod";
import { errorJson, handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { recordLiveTranscript } from "@/lib/meetings/service";

const liveTranscriptSchema = z.object({
  transcript: z.string().max(200_000),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = liveTranscriptSchema.safeParse(await request.json().catch(() => ({})));
  if (!body.success) return errorJson("Invalid live transcript payload", 422);

  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    const note = await recordLiveTranscript({
      noteId: id,
      workspaceId: workspace.id,
      transcript: body.data.transcript,
    });
    return { note };
  });
}
