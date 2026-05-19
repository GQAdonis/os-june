import { handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { createWorkspaceRealtimeTranscriptionClientSecret } from "@/lib/providers/realtime";

export async function POST() {
  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    return createWorkspaceRealtimeTranscriptionClientSecret(workspace.id);
  });
}
