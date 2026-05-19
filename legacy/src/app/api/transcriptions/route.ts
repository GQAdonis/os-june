import { errorJson, handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { getWorkspaceTranscriptionProvider } from "@/lib/providers/transcription";

export async function POST(request: Request) {
  const form = await request.formData();
  const audio = form.get("audio");
  const title = String(form.get("title") || "New note");
  if (!(audio instanceof File)) return errorJson("Audio file is required", 422);

  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    const provider = await getWorkspaceTranscriptionProvider(workspace.id);
    return provider.transcribe({ title, audioFile: audio });
  });
}
