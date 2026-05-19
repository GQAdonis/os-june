import { prisma } from "@/lib/db";
import { handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q")?.trim() || "";

  return handleRoute(async () => {
    const { workspace } = await getWorkspaceContext();
    if (!q) return { notes: [], gatedCount: 0 };

    const ageGate = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
    const baseWhere = {
      workspaceId: workspace.id,
      OR: [
        { title: { contains: q } },
        { summary: { contains: q } },
        { transcript: { contains: q } },
      ],
    };

    const notes = await prisma.note.findMany({
      where: workspace.plan === "BASIC" ? { ...baseWhere, date: { gte: ageGate } } : baseWhere,
      orderBy: { date: "desc" },
      take: 10,
    });

    const gatedCount =
      workspace.plan === "BASIC"
        ? await prisma.note.count({ where: { ...baseWhere, date: { lt: ageGate } } })
        : 0;

    return { notes, gatedCount };
  });
}
