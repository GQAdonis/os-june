import { z } from "zod";
import { createSession, hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorJson, handleRoute } from "@/lib/http";

const schema = z.object({
  name: z.string().min(1).max(80),
  email: z.email(),
  password: z.string().min(8),
  workspaceName: z.string().min(1).max(80).default("My workspace"),
});

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "workspace";
}

export async function POST(request: Request) {
  const body = schema.safeParse(await request.json());
  if (!body.success) return errorJson("Valid account details are required", 422);

  return handleRoute(async () => {
    const email = body.data.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new Error("Account already exists");

    const slugBase = slugify(body.data.workspaceName);
    const slug = `${slugBase}-${Math.random().toString(36).slice(2, 7)}`;
    const passwordHash = await hashPassword(body.data.password);
    const workspace = await prisma.workspace.create({
      data: {
        name: body.data.workspaceName,
        slug,
        spaces: { create: [{ name: "My notes", icon: "lock" }, { name: body.data.workspaceName, icon: "team" }] },
      },
    });
    const user = await prisma.user.create({
      data: {
        email,
        name: body.data.name,
        passwordHash,
        memberships: { create: { workspaceId: workspace.id, role: "OWNER" } },
      },
    });

    await createSession(user.id);
    return { ok: true };
  });
}
