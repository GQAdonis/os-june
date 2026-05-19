import { randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { errorJson, handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";

const schema = z.object({ noteId: z.string().min(1) });

export async function POST(request: Request) {
  const body = schema.safeParse(await request.json());
  if (!body.success) return errorJson("Note id is required", 422);

  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    const note = await prisma.note.findFirst({ where: { id: body.data.noteId, workspaceId: workspace.id } });
    if (!note) throw new Error("Note not found");

    const share = await prisma.share.create({
      data: { noteId: note.id, token: randomBytes(12).toString("base64url") },
    });
    await prisma.note.update({ where: { id: note.id }, data: { visibility: "PUBLIC" } });
    return { share, url: `/share/${share.token}` };
  });
}
