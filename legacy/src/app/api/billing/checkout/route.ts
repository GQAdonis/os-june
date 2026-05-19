import { prisma } from "@/lib/db";
import { handleRoute } from "@/lib/http";
import { getBillingProvider } from "@/lib/providers/billing";
import { getWorkspaceContext } from "@/lib/workspace";

export async function POST() {
  return handleRoute(async () => {
    const { user, workspace } = await getWorkspaceContext();
    const checkout = await getBillingProvider().createCheckout({
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      workspaceName: workspace.name,
      customerEmail: user.email,
      appUrl: process.env.APP_URL ?? "http://localhost:3000",
    });

    const currentPeriodEnd = checkout.currentPeriodEnd ?? new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
    const subscriptionStatus = checkout.status === "active" ? "ACTIVE" : "TRIALING";
    const subscription = await prisma.billingSubscription.upsert({
      where: { workspaceId: workspace.id },
      update: {
        provider: checkout.provider,
        providerCustomerId: checkout.customerId,
        providerSubscriptionId: checkout.subscriptionId,
        checkoutSessionId: checkout.checkoutSessionId,
        status: subscriptionStatus,
        currentPeriodEnd,
      },
      create: {
        workspaceId: workspace.id,
        provider: checkout.provider,
        providerCustomerId: checkout.customerId,
        providerSubscriptionId: checkout.subscriptionId,
        checkoutSessionId: checkout.checkoutSessionId,
        status: subscriptionStatus,
        currentPeriodEnd,
      },
    });
    const updated =
      checkout.status === "active"
        ? await prisma.workspace.update({ where: { id: workspace.id }, data: { plan: "PRO" } })
        : workspace;
    return { workspace: updated, subscription, checkoutUrl: checkout.url };
  });
}
