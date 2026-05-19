import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth";

export async function getWorkspaceContext() {
  const user = await requireUser();
  const membership = await prisma.membership.findFirst({
    where: { userId: user.id },
    include: { workspace: true },
    orderBy: { id: "asc" },
  });

  if (!membership) throw new Error("Workspace required");

  return { user, workspace: membership.workspace, role: membership.role };
}
