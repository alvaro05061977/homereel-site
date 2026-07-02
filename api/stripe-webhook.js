// Vercel serverless function: Stripe webhook — the ONLY thing that marks an order Paid.
//
// Stripe calls this endpoint directly (server-to-server) when a checkout finishes.
// We verify the request really came from Stripe (HMAC signature over the raw body),
// then flip the Airtable order's Payment Status. Zero npm dependencies.
//
// Env vars required (set in Vercel):
//   STRIPE_WEBHOOK_SECRET - the whsec_... signing secret from the Stripe webhook endpoint
//   AIRTABLE_TOKEN        - same token /api/order uses
//
// Stripe endpoint setup (Dashboard → Developers → Webhooks → Add endpoint):
//   URL:    https://homereel-site.vercel.app/api/stripe-webhook
//   Events: checkout.session.completed,
//           checkout.session.async_payment_succeeded,
//           checkout.session.async_payment_failed

import crypto from "crypto";

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const AIRTABLE_TABLE = "Orders";
const TOLERANCE_SECONDS = 300; // reject signatures older than 5 minutes (replay protection)

// Stripe signs the RAW request body — disable Vercel's JSON parsing.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Verify the Stripe-Signature header: "t=<ts>,v1=<sig>[,v1=<sig>...]"
function verifyStripeSignature(rawBody, header, secret) {
  if (!header) return false;
  const parts = {};
  for (const kv of header.split(",")) {
    const [k, v] = kv.split("=", 2);
    if (k === "v1") (parts.v1 = parts.v1 || []).push(v);
    else parts[k.trim()] = v;
  }
  const ts = parseInt(parts.t, 10);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac("sha256", secret)
    .update(`${parts.t}.${rawBody.toString("utf8")}`, "utf8")
    .digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  return (parts.v1 || []).some((sig) => {
    try {
      const sigBuf = Buffer.from(sig, "hex");
      return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch (_) { return false; }
  });
}

async function setPaymentStatus(token, recordId, status, sessionId) {
  const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}/${recordId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { "Payment Status": status, "Stripe Reference": sessionId }, typecast: true }),
  });
  if (!r.ok) throw new Error(`Airtable PATCH ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const token = process.env.AIRTABLE_TOKEN;
  if (!secret || !token) { console.error("webhook: missing env vars"); res.status(500).end(); return; }

  let rawBody;
  try { rawBody = await readRawBody(req); }
  catch (e) { console.error("webhook: body read failed:", String(e)); res.status(400).end(); return; }

  if (!verifyStripeSignature(rawBody, req.headers["stripe-signature"], secret)) {
    console.error("webhook: signature verification FAILED");
    res.status(400).json({ error: "Invalid signature" }); return;
  }

  let event;
  try { event = JSON.parse(rawBody.toString("utf8")); }
  catch (_) { res.status(400).json({ error: "Invalid payload" }); return; }

  try {
    const session = event.data && event.data.object;
    const recordId = session && session.metadata && session.metadata.airtable_id;

    switch (event.type) {
      case "checkout.session.completed":
        // Cards are paid immediately; delayed methods (e.g. bank debits) complete
        // now but pay later — those flip on async_payment_succeeded instead.
        if (recordId && session.payment_status === "paid") {
          await setPaymentStatus(token, recordId, "Paid", session.id);
        }
        break;
      case "checkout.session.async_payment_succeeded":
        if (recordId) await setPaymentStatus(token, recordId, "Paid", session.id);
        break;
      case "checkout.session.async_payment_failed":
        if (recordId) await setPaymentStatus(token, recordId, "Failed", session.id);
        break;
      default:
        break; // acknowledge everything else
    }
    res.status(200).json({ received: true });
  } catch (e) {
    // Non-200 makes Stripe retry (up to ~3 days) — exactly what we want if Airtable hiccuped.
    console.error("webhook: processing failed:", String(e));
    res.status(500).json({ error: "Processing failed" });
  }
}
