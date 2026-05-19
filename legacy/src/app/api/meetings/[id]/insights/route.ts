import { handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { refreshMeetingInsights } from "@/lib/meetings/service";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    const note = await refreshMeetingInsights({ noteId: id, workspaceId: workspace.id });
    return { note };
  });
}
