import { z } from "zod";
import { prisma } from "@/lib/db";
import { errorJson, handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";

const createNoteSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().optional(),
  spaceId: z.string().optional(),
});

export async function GET() {
  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    return {
      notes: await prisma.note.findMany({
        where: { workspaceId: workspace.id },
        include: { shares: true },
        orderBy: { date: "desc" },
      }),
    };
  });
}

export async function POST(request: Request) {
  const body = createNoteSchema.safeParse(await request.json());
  if (!body.success) return errorJson("Invalid note payload", 422);

  return handleRoute(async () => {
    const { user, workspace } = await getWorkspaceContext();
    const space =
      (body.data.spaceId && (await prisma.space.findFirst({ where: { id: body.data.spaceId, workspaceId: workspace.id } }))) ||
      (await prisma.space.findFirst({ where: { workspaceId: workspace.id }, orderBy: { createdAt: "asc" } }));
    if (!space) throw new Error("No space available");

    const note = await prisma.note.create({
      data: {
        title: body.data.title,
        summary: body.data.summary || "# New Note\n- Start typing or record a meeting to generate notes.",
        transcript: "",
        status: "DRAFT",
        workspaceId: workspace.id,
        ownerId: user.id,
        spaceId: space.id,
      },
      include: { shares: true },
    });

    return { note };
  });
}
