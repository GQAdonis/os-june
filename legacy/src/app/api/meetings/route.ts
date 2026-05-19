import { z } from "zod";
import { errorJson, handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { createMeetingNote } from "@/lib/meetings/service";

const createMeetingSchema = z.object({
  title: z.string().trim().min(1).max(120).default("New meeting"),
});

export async function POST(request: Request) {
  const body = createMeetingSchema.safeParse(await request.json());
  if (!body.success) return errorJson("Invalid meeting payload", 422);

  return handleRoute(async () => {
    const { user, workspace } = await getWorkspaceContext();
    const note = await createMeetingNote({
      title: body.data.title,
      userId: user.id,
      workspaceId: workspace.id,
    });
    return { note };
  });
}
