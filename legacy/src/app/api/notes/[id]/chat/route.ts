import { z } from "zod";
import { prisma } from "@/lib/db";
import { errorJson, handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { getAiProvider } from "@/lib/providers/ai";

const schema = z.object({ question: z.string().min(1).max(500) });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = schema.safeParse(await request.json());
  if (!body.success) return errorJson("Question is required", 422);

  return handleRoute(async () => {
    const { user, workspace } = await getWorkspaceContext();
    const note = await prisma.note.findFirst({ where: { id, workspaceId: workspace.id }, include: { turns: true } });
    if (!note) throw new Error("Note not found");

    await prisma.chatMessage.create({
      data: { noteId: note.id, userId: user.id, role: "user", content: body.data.question },
    });

    const answer = await getAiProvider().answerQuestion({ question: body.data.question, note });
    const assistant = await prisma.chatMessage.create({
      data: { noteId: note.id, userId: user.id, role: "assistant", content: answer },
    });

    return { message: assistant };
  });
}
