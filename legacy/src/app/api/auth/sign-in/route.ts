import { z } from "zod";
import { createSession, verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { errorJson, handleRoute } from "@/lib/http";

const schema = z.object({
  email: z.email(),
  password: z.string().min(8),
});

export async function POST(request: Request) {
  const body = schema.safeParse(await request.json());
  if (!body.success) return errorJson("Valid email and password are required", 422);

  return handleRoute(async () => {
    const user = await prisma.user.findUnique({ where: { email: body.data.email.toLowerCase() } });
    if (!user || !(await verifyPassword(body.data.password, user.passwordHash))) {
      throw new Error("Invalid credentials");
    }
    await createSession(user.id);
    return { ok: true };
  });
}
