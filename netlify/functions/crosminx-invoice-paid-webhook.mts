import type { Context, Config } from "@netlify/functions";
import Stripe from "stripe";

// CrosMinX Trading Corp -> verifies the incoming invoice.paid event
const crosminxStripe = new Stripe(Netlify.env.get("CROSMINX_TRADING_STRIPE_SECRET_KEY") || "", {
  apiVersion: "2024-06-20",
});

// Croshire Estates Corp -> creates the admin/consulting invoice TO Crosbies
const croshireStripe = new Stripe(Netlify.env.get("CROSHIRE_ESTATES_STRIPE_SECRET_KEY") || "", {
  apiVersion: "2024-06-20",
});

const COMBINED_CAP_CENTS = 3500; // $35 total across both invoices
const CROSHIRE_PERCENT = 0.10; // 10% of what CrosMinX was paid

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
  const webhookSecret = Netlify.env.get("CROSMINX_TRADING_STRIPE_WEBHOOK_SECRET") || "";
  const signature = req.headers.get("stripe-signature") || "";
  const rawBody = await req.text();

  let event: Stripe.Event;
  try {
    event = crosminxStripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error("crosminx-invoice-paid-webhook: signature verification failed", err);
    return new Response("Webhook signature verification failed", { status: 400 });
  }

  if (event.type !== "invoice.paid") {
    return new Response(JSON.stringify({ received: true, skipped: event.type }), { status: 200 });
  }

  const invoice = event.data.object as Stripe.Invoice;

  // Only chain off invoices that originated from crosbies-sale-webhook
  if (invoice.metadata?.source !== "crosbies_sale_webhook") {
    return new Response(JSON.stringify({ received: true, skipped: "not_chain_invoice" }), { status: 200 });
  }

  const amountPaid = invoice.amount_paid || 0; // cents, what CrosMinX was actually paid
  const crosminxAmount = Number(invoice.metadata?.crosminx_amount || amountPaid);
  const remainingCapRoom = Math.max(COMBINED_CAP_CENTS - crosminxAmount, 0);
  const croshireAmount = Math.min(Math.round(amountPaid * CROSHIRE_PERCENT), remainingCapRoom);

  if (croshireAmount <= 0) {
    console.log("crosminx-invoice-paid-webhook: no room left under combined cap, skipping", invoice.id);
    return new Response(JSON.stringify({ received: true, skipped: "cap_reached" }), { status: 200 });
  }

  try {
    const customer = await findOrCreateCustomer(croshireStripe, CROSBIES_CUSTOMER_EMAIL, CROSBIES_CUSTOMER_NAME);

    const newInvoice = await croshireStripe.invoices.create({
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: 7,
      auto_advance: true,
      metadata: {
        source: "crosminx_invoice_paid_webhook",
        crosbies_session_id: invoice.metadata?.crosbies_session_id || "",
        crosminx_invoice_id: invoice.id,
      },
      description: "Administrative & consulting services -- Crosbies Hot Sauce Corp",
    });

    await croshireStripe.invoiceItems.create({
      customer: customer.id,
      invoice: newInvoice.id,
      amount: croshireAmount,
      currency: invoice.currency || "usd",
      description: `Admin/consulting (10% of CrosMinX payment, combined cap $35) -- invoice ${invoice.id}`,
    });

    const finalized = await croshireStripe.invoices.finalizeInvoice(newInvoice.id);
    await croshireStripe.invoices.sendInvoice(finalized.id);

    console.log("crosminx-invoice-paid-webhook: Croshire invoice created + sent", finalized.id, croshireAmount);

    return new Response(
      JSON.stringify({ received: true, croshire_invoice_id: finalized.id, amount_cents: croshireAmount }),
      { status: 200 }
    );
  } catch (err) {
    console.error("crosminx-invoice-paid-webhook: failed to create Croshire invoice", err);
    return new Response(JSON.stringify({ received: true, error: "invoice_creation_failed" }), { status: 200 });
  }
};

export const config: Config = {
  path: "/crosminx-invoice-paid-webhook",
};
