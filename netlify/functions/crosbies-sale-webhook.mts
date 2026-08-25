import type { Context, Config } from "@netlify/functions";
import Stripe from "stripe";

// Crosbies Hot Sauce Corp -> verifies the incoming sale event
const crosbiesStripe = new Stripe(Netlify.env.get("CROSBIES_STRIPE_SECRET_KEY") || "", {
  apiVersion: "2024-06-20",
});

// CrosMinX Trading Corp -> creates the packaging/fulfillment invoice TO Crosbies
const crosminxStripe = new Stripe(Netlify.env.get("CROSMINX_TRADING_STRIPE_SECRET_KEY") || "", {
  apiVersion: "2024-06-20",
});

const CROSMINX_CAP_CENTS = 3000; // $30 max
const CROSMINX_PERCENT = 0.20; // 20% of sale

const CROSBIES_CUSTOMER_EMAIL = "info@crosbieshotsauce.com";
const CROSBIES_CUSTOMER_NAME = "Crosbies Hot Sauce Corp";

async function findOrCreateCustomer(stripeClient: Stripe, email: string, name: string) {
  const existing = await stripeClient.customers.list({ email, limit: 1 });
  if (existing.data.length > 0) {
    return existing.data[0];
  }
  return stripeClient.customers.create({ email, name });
}

export default async (req: Request, context: Context) => {
  const webhookSecret = Netlify.env.get("CROSBIES_STRIPE_WEBHOOK_SECRET") || "";
  const signature = req.headers.get("stripe-signature") || "";
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = crosbiesStripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("crosbies-sale-webhook: signature verification failed", err);
    return new Response("Webhook signature verification failed", { status: 400 });
  }

  if (event.type !== "checkout.session.completed") {
    // Not the event we care about -- acknowledge and exit
    return new Response(JSON.stringify({ received: true, skipped: event.type }), { status: 200 });
  }

  const session = event.data.object as Stripe.Checkout.Session;

  if (session.payment_status !== "paid") {
    console.log("crosbies-sale-webhook: session not paid yet, skipping", session.id);
    return new Response(JSON.stringify({ received: true, skipped: "not_paid" }), { status: 200 });
  }

  const amountTotal = session.amount_total || 0; // cents
  const crosminxAmount = Math.min(Math.round(amountTotal * CROSMINX_PERCENT), CROSMINX_CAP_CENTS);

  if (crosminxAmount <= 0) {
    return new Response(JSON.stringify({ received: true, skipped: "zero_amount" }), { status: 200 });
  }

  try {
    const customer = await findOrCreateCustomer(crosminxStripe, CROSBIES_CUSTOMER_EMAIL, CROSBIES_CUSTOMER_NAME);

    const invoice = await crosminxStripe.invoices.create({
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: 7,
      auto_advance: true,
      metadata: {
        source: "crosbies_sale_webhook",
        crosbies_session_id: session.id,
        crosminx_amount: String(crosminxAmount),
      },
      description: "Packaging & fulfillment services -- Crosbies Hot Sauce Corp",
    });

    await crosminxStripe.invoiceItems.create({
      customer: customer.id,
      invoice: invoice.id,
      amount: crosminxAmount,
      currency: session.currency || "usd",
      description: `Packaging/fulfillment (20% of sale, capped at $30) -- session ${session.id}`,
    });

    const finalized = await crosminxStripe.invoices.finalizeInvoice(invoice.id);
    await crosminxStripe.invoices.sendInvoice(finalized.id);

    console.log("crosbies-sale-webhook: CrosMinX invoice created + sent", finalized.id, crosminxAmount);

    return new Response(
      JSON.stringify({ received: true, crosminx_invoice_id: finalized.id, amount_cents: crosminxAmount }),
      { status: 200 }
    );
  } catch (err) {
    console.error("crosbies-sale-webhook: failed to create CrosMinX invoice", err);
    // Still return 200 so Stripe doesn't endlessly retry a logic error;
    // the failure is logged for manual follow-up.
    return new Response(JSON.stringify({ received: true, error: "invoice_creation_failed" }), { status: 200 });
  }
};

export const config: Config = {
  path: "/crosbies-sale-webhook",
};
