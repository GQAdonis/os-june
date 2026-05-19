import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCalendarProvider } from "@/lib/providers/calendar";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const workspaceId = url.searchParams.get("state");
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";

  if (!code || !workspaceId) {
    redirect(`${appUrl}?calendar=missing_code`);
  }

  const provider = getCalendarProvider();
  if (!provider.connectWithCode) {
    redirect(`${appUrl}?calendar=unsupported`);
  }

  const connected = await provider.connectWithCode(code);
  await prisma.calendarConnection.upsert({
    where: { workspaceId },
    update: {
      provider: connected.provider,
      providerUserId: connected.providerUserId,
      accessToken: connected.accessToken,
      refreshToken: connected.refreshToken,
      expiresAt: connected.expiresAt,
      events: {
        deleteMany: {},
        create: connected.events,
      },
    },
    create: {
      workspaceId,
      provider: connected.provider,
      providerUserId: connected.providerUserId,
      accessToken: connected.accessToken,
      refreshToken: connected.refreshToken,
      expiresAt: connected.expiresAt,
      events: { create: connected.events },
    },
  });

  redirect(`${appUrl}?calendar=connected`);
}
