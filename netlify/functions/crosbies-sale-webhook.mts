import type { Context, Config } from "@netlify/functions";
import Stripe from "stripe";

// Crosbies Hot Sauce Corp -> verifies the incoming sale/renewal event
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

// Shared logic: given a sale amount (cents) and a source identifier, create the
// CrosMinX Trading invoice for 20% (capped at $30). Used for both the initial
// checkout AND every subscription renewal after it.
async function createCrosminxInvoice(params: {
  amountTotal: number;
  currency: string;
  sourceId: string; // checkout session id OR invoice id, whichever triggered this
  sourceType: "checkout_session" | "subscription_renewal";
}) {
  const { amountTotal, currency, sourceId, sourceType } = params;
  const crosminxAmount = Math.min(Math.round(amountTotal * CROSMINX_PERCENT), CROSMINX_CAP_CENTS);

  if (crosminxAmount <= 0) {
    return { skipped: "zero_amount" as const };
  }

  const customer = await findOrCreateCustomer(crosminxStripe, CROSBIES_CUSTOMER_EMAIL, CROSBIES_CUSTOMER_NAME);

  const invoice = await crosminxStripe.invoices.create({
    customer: customer.id,
    collection_method: "send_invoice",
    days_until_due: 7,
    auto_advance: true,
    metadata: {
      source: "crosbies_sale_webhook",
      source_type: sourceType,
      crosbies_source_id: sourceId,
      crosminx_amount: String(crosminxAmount),
    },
    description:
      sourceType === "subscription_renewal"
        ? "Packaging & fulfillment services -- Crosbies Hot Sauce Corp (subscription renewal)"
        : "Packaging & fulfillment services -- Crosbies Hot Sauce Corp",
  });

  await crosminxStripe.invoiceItems.create({
    customer: customer.id,
    invoice: invoice.id,
    amount: crosminxAmount,
    currency,
    description: `Packaging/fulfillment (20% of sale, capped at $30) -- ${sourceType} ${sourceId}`,
  });

  const finalized = await crosminxStripe.invoices.finalizeInvoice(invoice.id);
  await crosminxStripe.invoices.sendInvoice(finalized.id);

  return { invoiceId: finalized.id, amountCents: crosminxAmount };
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

  try {
    // CASE 1: First-time purchase (one-time sale OR the very first subscription invoice)
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;

      if (session.payment_status !== "paid") {
        console.log("crosbies-sale-webhook: session not paid yet, skipping", session.id);
        return new Response(JSON.stringify({ received: true, skipped: "not_paid" }), { status: 200 });
      }

      const result = await createCrosminxInvoice({
        amountTotal: session.amount_total || 0,
        currency: session.currency || "usd",
        sourceId: session.id,
        sourceType: "checkout_session",
      });

      console.log("crosbies-sale-webhook: checkout session processed", session.id, result);
      return new Response(JSON.stringify({ received: true, ...result }), { status: 200 });
    }

    // CASE 2: Subscription RENEWAL (recurring cycle, not the first invoice --
    // the first invoice is already covered by checkout.session.completed above,
    // so we explicitly skip billing_reason "subscription_create" here to avoid
    // double-invoicing the same payment).
    if (event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice;

      if (invoice.billing_reason !== "subscription_cycle") {
        return new Response(
          JSON.stringify({ received: true, skipped: `billing_reason:${invoice.billing_reason}` }),
          { status: 200 }
        );
      }

      const result = await createCrosminxInvoice({
        amountTotal: invoice.amount_paid || 0,
        currency: invoice.currency || "usd",
        sourceId: invoice.id,
        sourceType: "subscription_renewal",
      });

      console.log("crosbies-sale-webhook: subscription renewal processed", invoice.id, result);
      return new Response(JSON.stringify({ received: true, ...result }), { status: 200 });
    }

    // Any other event type -- acknowledge and exit
    return new Response(JSON.stringify({ received: true, skipped: event.type }), { status: 200 });
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
