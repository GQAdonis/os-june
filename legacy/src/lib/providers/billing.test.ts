import { afterEach, describe, expect, it, vi } from "vitest";
import { MockBillingProvider, StripeBillingProvider } from "@/lib/providers/billing";

describe("MockBillingProvider", () => {
  it("upgrades immediately for local development", async () => {
    const provider = new MockBillingProvider();
    const checkout = await provider.createCheckout({
      workspaceId: "workspace_1",
      workspaceSlug: "acme",
      workspaceName: "Acme",
      customerEmail: "jun@example.com",
      appUrl: "http://localhost:3000",
    });

    expect(checkout.status).toBe("active");
    expect(checkout.provider).toBe("mock");
    expect(checkout.currentPeriodEnd).toBeInstanceOf(Date);
  });
});

describe("StripeBillingProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates hosted checkout sessions through Stripe", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "cs_test_123",
          url: "https://checkout.stripe.com/c/pay/cs_test_123",
          customer: "cus_123",
        }),
        { status: 200 },
      ),
    );
    const provider = new StripeBillingProvider("sk_test_123", "price_123");
    const checkout = await provider.createCheckout({
      workspaceId: "workspace_1",
      workspaceSlug: "acme",
      workspaceName: "Acme",
      customerEmail: "jun@example.com",
      appUrl: "http://localhost:3000",
    });

    expect(checkout).toMatchObject({
      provider: "stripe",
      status: "checkout_required",
      checkoutSessionId: "cs_test_123",
      customerId: "cus_123",
      url: "https://checkout.stripe.com/c/pay/cs_test_123",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/checkout/sessions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("validates Stripe price configuration without creating checkout sessions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "price_123", active: true }), { status: 200 }),
    );
    const provider = new StripeBillingProvider("sk_test_123", "price_123");

    await expect(provider.verifyConfiguration()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/prices/price_123",
      expect.objectContaining({
        headers: { Authorization: "Bearer sk_test_123" },
      }),
    );
  });

  it("parses checkout completion webhook payloads", async () => {
    const provider = new StripeBillingProvider("sk_test_123", "price_123");
    const request = new Request("http://localhost/api/billing/webhook", {
      method: "POST",
      body: JSON.stringify({
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_test_123",
            client_reference_id: "workspace_1",
            customer: "cus_123",
            subscription: "sub_123",
          },
        },
      }),
    });

    await expect(provider.parseWebhook(request)).resolves.toMatchObject({
      workspaceId: "workspace_1",
      checkoutSessionId: "cs_test_123",
      customerId: "cus_123",
      subscriptionId: "sub_123",
      status: "ACTIVE",
    });
  });
});
