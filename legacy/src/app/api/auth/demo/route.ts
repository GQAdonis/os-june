import { createSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorJson, handleRoute } from "@/lib/http";

export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return errorJson("Not found", 404);
  }

  return handleRoute(async () => {
    let user = await prisma.user.findUnique({ where: { email: "jun@example.com" } });
    if (!user) {
      const workspace = await prisma.workspace.create({
        data: {
          name: "Jun team",
          slug: "jun-team",
          spaces: { create: [{ name: "My notes", icon: "lock" }, { name: "Jun team", icon: "team" }] },
        },
      });
      user = await prisma.user.create({
        data: {
          email: "jun@example.com",
          name: "Jun",
          memberships: { create: { workspaceId: workspace.id, role: "OWNER" } },
        },
      });
    }
    await createSession(user.id);
    return { ok: true };
  });
}
