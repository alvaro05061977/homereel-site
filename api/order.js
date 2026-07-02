// Vercel serverless function: receives a wizard order, saves it to Airtable Orders,
// then creates an itemized Stripe Checkout session and returns its URL.
//
// SECURITY MODEL (2026-07-02 fix): the browser sends only *IDs* (package, add-ons,
// formats, extra-room count). This file owns the canonical price table, rebuilds
// every line item server-side, and rejects anything not on the whitelist. Client-
// sent prices are never used — the client total is only cross-checked so a stale
// or tampered page fails loudly instead of charging the wrong amount.
//
// Env vars required (set in Vercel → Project → Settings → Environment Variables):
//   AIRTABLE_TOKEN     - Airtable personal access token (data.records:read+write on the HomeReel base)
//   STRIPE_SECRET_KEY  - Stripe secret key (sk_live_... or sk_test_...)

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const AIRTABLE_TABLE = "Orders";
const SOUNDTRACKS_TABLE = "Soundtracks";
const SITE = "https://homereel-site.vercel.app";

// ---- Canonical catalog: the ONLY source of prices. ----
// extraRoomCap: the canonical room catalog has exactly 12 types (Prompt_Engine.md),
// so extras can only top a package up to 12 total rooms.
const PACKAGES = {
  essential: { name: "Essential", price: 500, extraRoomCap: 6 },
  signature: { name: "Signature", price: 750, extraRoomCap: 4 },
  showcase:  { name: "Showcase",  price: 1200, extraRoomCap: 0 },
};
const ADDONS = {
  avatar:        { lineName: "Star in your own film",         airtable: "Agent avatar (+$250)",  price: 250 },
  second_family: { lineName: "Add a second family version",   airtable: "Second family (+$300)", price: 300 },
  rush:          { lineName: "Rush — 12-hour delivery",       airtable: "Rush 12h (+$150)",      price: 150 },
};
const FORMATS = {
  "16:9": { airtable: "16:9 Widescreen",    price: 0  },
  "9:16": { airtable: "9:16 Vertical",      price: 0  },
  "1:1":  { airtable: "1:1 Square (+$75)",  price: 75 },
};
const FAMILIES = { carters: "The Carters" };
const EXTRA_ROOM_PRICE = 60;
const MAX_PHOTOS = 40;
const CLOUDINARY_PREFIX = "https://res.cloudinary.com/f2kjjypa/";

// Trim + cap a client string; never trust length or type.
function str(v, max) { return typeof v === "string" ? v.trim().slice(0, max) : ""; }

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const token = process.env.AIRTABLE_TOKEN;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!token || !stripeKey) { res.status(500).json({ error: "Server not configured." }); return; }

  try {
    const o = req.body || {};

    // ---- 0. Validate + rebuild the order entirely server-side ----
    const pkg = PACKAGES[o.packageId];
    if (!pkg) { res.status(400).json({ error: "Unknown package." }); return; }

    const familyName = FAMILIES[o.familyId];
    if (!familyName) { res.status(400).json({ error: "Unknown family." }); return; }

    const addonIds = Array.isArray(o.addonIds) ? [...new Set(o.addonIds)] : [];
    if (addonIds.some((id) => !ADDONS[id])) { res.status(400).json({ error: "Unknown add-on." }); return; }

    const formatIds = Array.isArray(o.formatIds) ? [...new Set(o.formatIds)] : [];
    if (formatIds.some((id) => !FORMATS[id])) { res.status(400).json({ error: "Unknown format." }); return; }

    const extraRooms = Number.isInteger(o.extraRooms) ? o.extraRooms : parseInt(o.extraRooms, 10) || 0;
    if (extraRooms < 0 || extraRooms > pkg.extraRoomCap) { res.status(400).json({ error: "Invalid extra room count." }); return; }

    const address = str(o.address, 200), agent = str(o.agent, 120), email = str(o.email, 200);
    if (!address || !agent || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "Missing or invalid address, agent name, or email." }); return;
    }

    // Photos: only URLs from our own Cloudinary account, capped.
    let photoUrls = Array.isArray(o.photoUrls) ? o.photoUrls : [];
    photoUrls = photoUrls
      .filter((u) => typeof u === "string" && u.length <= 500 && u.startsWith(CLOUDINARY_PREFIX))
      .slice(0, MAX_PHOTOS);

    // Server-computed line items + total (canonical).
    const lineItems = [[`Package — ${pkg.name}`, pkg.price]];
    for (const id of Object.keys(ADDONS)) {
      if (addonIds.includes(id)) lineItems.push([ADDONS[id].lineName, ADDONS[id].price]);
    }
    if (extraRooms > 0) lineItems.push([`${extraRooms} extra room${extraRooms > 1 ? "s" : ""}`, extraRooms * EXTRA_ROOM_PRICE]);
    for (const id of formatIds) {
      if (FORMATS[id].price > 0) lineItems.push(["Square format", FORMATS[id].price]);
    }
    const total = lineItems.reduce((s, i) => s + i[1], 0);

    // Cross-check the total the customer SAW. A mismatch means a stale/tampered
    // page — refuse rather than charge something the customer didn't see.
    if (o.total !== undefined && Number(o.total) !== total) {
      console.warn(`order: client total ${o.total} != server total ${total} — rejected`);
      res.status(400).json({ error: "Price mismatch — please refresh the page and try again." }); return;
    }

    // Soundtrack: client sends the Airtable record id from /api/soundtracks.
    // Verify it's a real, Active soundtrack; otherwise fall back to editor's pick.
    let soundtrackLink;
    const stId = str(o.soundtrackId, 20);
    if (/^rec[a-zA-Z0-9]{14}$/.test(stId)) {
      try {
        const stRes = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(SOUNDTRACKS_TABLE)}/${stId}`,
          { headers: { Authorization: `Bearer ${token}` } });
        if (stRes.ok) {
          const rec = await stRes.json();
          if (rec.fields && rec.fields["Active"]) soundtrackLink = [stId];
        }
      } catch (_) { /* editor's pick */ }
    }

    // ---- 1. Create the Airtable order record (all option values server-derived) ----
    const fields = {
      "Listing / Order": address,
      "Agent Name": agent,
      "Brokerage": str(o.brokerage, 120),
      "Phone": str(o.phone, 40),
      "Email": email,
      "Handle / Website": str(o.handle, 200),
      "Package": [pkg.name],                                   // typecast links by name (whitelisted)
      "Family": [familyName],
      "Soundtrack": soundtrackLink,                            // linked by verified record id; blank = editor's pick
      "Add-ons": addonIds.map((id) => ADDONS[id].airtable),
      "Extra Rooms": extraRooms,
      "Formats": formatIds.map((id) => FORMATS[id].airtable),
      "Voiceover Script": str(o.vo, 5000),
      "Not for MLS Acknowledged": !!o.mls,
      "Payment Status": "Unpaid",                              // flipped to Paid ONLY by the Stripe webhook
      "Job Status": "New",
      "Order Date": new Date().toISOString().slice(0, 10),
      "Notes": `Server-verified total $${total}. ${photoUrls.length} listing photo(s) attached.`,
    };
    if (photoUrls.length) fields["Listing Photos"] = photoUrls.map((u) => ({ url: u }));

    const atRes = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields, typecast: true }),
    });
    if (!atRes.ok) {
      console.error("Airtable error:", atRes.status, (await atRes.text()).slice(0, 500));
      res.status(502).json({ error: "We couldn't save your order. Please try again or email us." }); return;
    }
    const record = await atRes.json();

    // ---- 2. Create the Stripe Checkout session from SERVER-priced line items ----
    const params = new URLSearchParams();
    params.append("mode", "payment");
    params.append("success_url", `${SITE}/success.html?cs={CHECKOUT_SESSION_ID}`);
    params.append("cancel_url", `${SITE}/wizard.html`);
    params.append("customer_email", email);
    params.append("metadata[airtable_id]", record.id);
    lineItems.forEach(([name, amount], i) => {
      params.append(`line_items[${i}][price_data][currency]`, "usd");
      params.append(`line_items[${i}][price_data][product_data][name]`, name);
      params.append(`line_items[${i}][price_data][unit_amount]`, String(Math.round(amount * 100)));
      params.append(`line_items[${i}][quantity]`, "1");
    });
    const stRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    if (!stRes.ok) {
      console.error("Stripe error:", stRes.status, (await stRes.text()).slice(0, 500));
      res.status(502).json({ error: "We couldn't start the payment. Please try again or email us." }); return;
    }
    const session = await stRes.json();

    // ---- 3. Save the Stripe reference back to the order (awaited — Vercel freezes
    //         the function after the response, so fire-and-forget never ran) ----
    try {
      await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}/${record.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { "Stripe Reference": session.id } }),
      });
    } catch (e) { console.error("Stripe Reference PATCH failed:", String(e)); }

    res.status(200).json({ url: session.url });
  } catch (e) {
    console.error("order: unexpected error:", String(e));
    res.status(500).json({ error: "Unexpected error. Please try again or email us." });
  }
}
