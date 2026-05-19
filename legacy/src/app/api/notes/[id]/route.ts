import { prisma } from "@/lib/db";
import { errorJson, handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    const note = await prisma.note.findFirst({
      where: { id, workspaceId: workspace.id },
      include: { turns: true, shares: true, messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!note) throw new Error("Note not found");
    return { note };
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();
  if (typeof body.summary !== "string" && typeof body.title !== "string") {
    return errorJson("Nothing to update", 422);
  }
  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    const existing = await prisma.note.findFirst({ where: { id, workspaceId: workspace.id } });
    if (!existing) throw new Error("Note not found");
    const note = await prisma.note.update({
      where: { id },
      data: {
        title: typeof body.title === "string" ? body.title : undefined,
        summary: typeof body.summary === "string" ? body.summary : undefined,
      },
      include: { turns: true, shares: true, messages: { orderBy: { createdAt: "asc" } } },
    });
    return { note };
  });
}
