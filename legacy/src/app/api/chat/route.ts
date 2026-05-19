import { z } from "zod";
import { prisma } from "@/lib/db";
import { errorJson, handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";
import { getAiProvider } from "@/lib/providers/ai";

const schema = z.object({ question: z.string().min(1).max(500) });

export async function POST(request: Request) {
  const body = schema.safeParse(await request.json());
  if (!body.success) return errorJson("Question is required", 422);

  return handleRoute(async () => {
    const { user, workspace } = await getWorkspaceContext();
    const notes = await prisma.note.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { date: "desc" },
      take: 5,
    });
    const answer = await getAiProvider().answerQuestion({
      question: body.data.question,
      note: notes[0] ? { ...notes[0], turns: [] } : undefined,
    });
    await prisma.chatMessage.create({ data: { userId: user.id, role: "user", content: body.data.question } });
    const message = await prisma.chatMessage.create({ data: { userId: user.id, role: "assistant", content: answer } });
    return { message };
  });
}
