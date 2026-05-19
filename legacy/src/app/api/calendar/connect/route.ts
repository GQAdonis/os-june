import { getCalendarProvider } from "@/lib/providers/calendar";
import { prisma } from "@/lib/db";
import { handleRoute } from "@/lib/http";
import { getWorkspaceContext } from "@/lib/workspace";

export async function POST() {
  return handleRoute(async () => {
    const { user, workspace } = await getWorkspaceContext();
    const provider = getCalendarProvider();
    if (provider.getAuthorizationUrl) {
      const authorizationUrl = provider.getAuthorizationUrl(workspace.id);
      return { authorizationUrl };
    }

    const connected = await provider.connect(user.email);

    const connection = await prisma.calendarConnection.upsert({
      where: { workspaceId: workspace.id },
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
        workspaceId: workspace.id,
        provider: connected.provider,
        providerUserId: connected.providerUserId,
        accessToken: connected.accessToken,
        refreshToken: connected.refreshToken,
        expiresAt: connected.expiresAt,
        events: { create: connected.events },
      },
      include: { events: { orderBy: { startsAt: "asc" } } },
    });

    return { connection };
  });
}
