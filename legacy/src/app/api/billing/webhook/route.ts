import { prisma } from "@/lib/db";
import { handleRoute } from "@/lib/http";
import { getBillingProvider } from "@/lib/providers/billing";

export async function POST(request: Request) {
  return handleRoute(async () => {
    const provider = getBillingProvider();
    const event = provider.parseWebhook ? await provider.parseWebhook(request) : null;
    if (!event?.workspaceId) return { ok: true, ignored: true };

    const currentPeriodEnd = event.currentPeriodEnd ?? new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
    await prisma.billingSubscription.upsert({
      where: { workspaceId: event.workspaceId },
      update: {
        providerCustomerId: event.customerId,
        providerSubscriptionId: event.subscriptionId,
        checkoutSessionId: event.checkoutSessionId,
        status: event.status,
        currentPeriodEnd,
      },
      create: {
        workspaceId: event.workspaceId,
        providerCustomerId: event.customerId,
        providerSubscriptionId: event.subscriptionId,
        checkoutSessionId: event.checkoutSessionId,
        status: event.status,
        currentPeriodEnd,
      },
    });

    await prisma.workspace.update({
      where: { id: event.workspaceId },
      data: { plan: event.status === "ACTIVE" ? "PRO" : "BASIC" },
    });

    return { ok: true };
  });
}
