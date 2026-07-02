// Vercel serverless function: tells success.html whether a checkout session is
// actually PAID — asked of Stripe directly, server-side. Returns only a boolean
// so the page can't be tricked and no payment details leak.
//
// Env var required (already set for /api/order): STRIPE_SECRET_KEY

export default async function handler(req, res) {
  if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) { res.status(500).json({ error: "Server not configured." }); return; }

  const cs = typeof req.query.cs === "string" ? req.query.cs : "";
  if (!/^cs_(test|live)_[a-zA-Z0-9]{10,200}$/.test(cs)) {
    res.status(400).json({ error: "Invalid session id." }); return;
  }

  try {
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${cs}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    if (!r.ok) {
      // Unknown/foreign session id — treat as not paid, don't leak Stripe's error.
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ paid: false }); return;
    }
    const session = await r.json();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      paid: session.payment_status === "paid",
      open: session.status === "open", // checkout still in progress (e.g. pending async payment)
    });
  } catch (e) {
    console.error("session-status: unexpected error:", String(e));
    res.status(500).json({ error: "Unexpected error." });
  }
}
