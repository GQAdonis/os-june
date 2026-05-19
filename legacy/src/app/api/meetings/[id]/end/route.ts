import { handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { endMeeting } from "@/lib/meetings/service";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    const payload = await readEndPayload(_request);
    const note = await endMeeting({
      noteId: id,
      workspaceId: workspace.id,
      supplementalText: payload.supplementalText,
    });
    return { note };
  });
}

async function readEndPayload(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) return { supplementalText: undefined };
  const body = (await request.json().catch(() => ({}))) as { supplementalText?: unknown };
  return {
    supplementalText: typeof body.supplementalText === "string" ? body.supplementalText : undefined,
  };
}
