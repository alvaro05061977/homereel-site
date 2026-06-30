// Vercel serverless function: receives a wizard order, saves it to Airtable Orders,
// then creates an itemized Stripe Checkout session and returns its URL.
// Env vars required (set in Vercel → Project → Settings → Environment Variables):
//   AIRTABLE_TOKEN     - Airtable personal access token (scopes: data.records:write, on the HomeReel base)
//   STRIPE_SECRET_KEY  - Stripe secret key (sk_live_... or sk_test_...)
// Photos are handled in a later stage (Vercel request size limits); for now we record the count.

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const AIRTABLE_TABLE = "Orders";
const SITE = "https://homereel-site.vercel.app";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const token = process.env.AIRTABLE_TOKEN;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!token || !stripeKey) { res.status(500).json({ error: "Server not configured: missing AIRTABLE_TOKEN or STRIPE_SECRET_KEY." }); return; }

  try {
    const o = req.body || {};
    // ---- 1. Create the Airtable order record ----
    const fields = {
      "Listing / Order": o.address || "",
      "Agent Name": o.agent || "",
      "Brokerage": o.brokerage || "",
      "Phone": o.phone || "",
      "Email": o.email || "",
      "Handle / Website": o.handle || "",
      "Package": o.packageName ? [o.packageName] : undefined,        // typecast links by name
      "Family": o.familyName ? [o.familyName] : undefined,
      "Soundtrack": o.soundtrackName ? [o.soundtrackName] : undefined, // link by track name; blank = editor's pick
      "Add-ons": Array.isArray(o.addonNames) ? o.addonNames : [],
      "Extra Rooms": Number(o.extraRooms) || 0,
      "Formats": Array.isArray(o.formatNames) ? o.formatNames : [],
      "Voiceover Script": o.vo || "",
      "Not for MLS Acknowledged": !!o.mls,
      "Payment Status": "Unpaid",
      "Job Status": "New",
      "Order Date": new Date().toISOString().slice(0, 10),
      "Notes": `Quoted total $${o.total}. ${o.photoCount || 0} listing photo(s) attached.`,
    };
    // Listing photos: the browser already uploaded them to Cloudinary; we pass the links
    // and Airtable ingests them into its own storage as downloadable attachments.
    if (Array.isArray(o.photoUrls) && o.photoUrls.length) {
      fields["Listing Photos"] = o.photoUrls.map((u) => ({ url: u }));
    }
    const atRes = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields, typecast: true }),
    });
    if (!atRes.ok) { const t = await atRes.text(); res.status(502).json({ error: "Airtable error", detail: t }); return; }
    const record = await atRes.json();

    // ---- 2. Create the Stripe Checkout session (itemized) ----
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", `${SITE}/success.html?cs={CHECKOUT_SESSION_ID}`);
    params.append("cancel_url", `${SITE}/wizard.html`);
    if (o.email) params.append("customer_email", o.email);
    params.append("metadata[airtable_id]", record.id);
    (o.lineItems || []).forEach((li, i) => {
      params.append(`line_items[${i}][price_data][currency]`, "usd");
      params.append(`line_items[${i}][price_data][product_data][name]`, li.name);
      params.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(li.amount * 100)));
      params.append(`line_items[${i}][quantity]`, "1");
    });
    const stRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    if (!stRes.ok) { const t = await stRes.text(); res.status(502).json({ error: "Stripe error", detail: t }); return; }
    const session = await stRes.json();

    // ---- 3. Save the Stripe reference back to the order (best-effort) ----
    fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}/${record.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Stripe Reference": session.id } }),
    }).catch(() => {});

    res.status(200).json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: "Unexpected error", detail: String(e) });
  }
}
