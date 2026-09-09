// Vercel serverless function: put an order's images into Magnific.
//
// POST /api/plates   { order: "recXXXXXXXXXXXXXX", force?: true }   (?k=<QC_KEY>)
// GET  /api/plates?order=recXXXXXXXXXXXXXX&k=<QC_KEY>               (same thing, for a human)
//   → { ok, job, uploaded, skipped, failed, items: [...] }
//
// Called by api/stripe-webhook.js the moment payment clears, and safe to call
// again by hand or from api/produce — see lib/plates.js for why every repeat is
// free and harmless.
//
// It is a SEPARATE endpoint rather than code inside the webhook on purpose. A
// function invoked over HTTP has its own lifetime, so the webhook can answer
// Stripe in milliseconds while this one takes as long as eight uploads need.
//
// `force: true` re-uploads images that already have an identifier. For when a
// creation was deleted in Magnific, not for routine use — it makes duplicates.
//
// Env vars:
//   QC_KEY          required — same shared secret the QC viewer uses
//   AIRTABLE_TOKEN  required
//   MAGNIFIC_*      read by lib/magnific.js

import { ingestPlates } from "../lib/plates.js";
import { MagnificError } from "../lib/magnific.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  // Required, never optional. api/qc.js reads an unset key as "internal
  // testing" and serves everything; that is how it sat open to the world until
  // 2026-09-08, and this endpoint will not repeat it.
  const qcKey = process.env.QC_KEY;
  if (!qcKey) {
    res.status(503).json({ error: "QC_KEY is not set; this endpoint stays closed until it is." });
    return;
  }
  const supplied = (req.query && req.query.k) || (req.body && req.body.k) || "";
  if (supplied !== qcKey) { res.status(401).json({ error: "Unauthorized." }); return; }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) { res.status(500).json({ error: "Server not configured." }); return; }

  const orderId = String((req.query && req.query.order) || (req.body && req.body.order) || "");
  const force = Boolean((req.body && req.body.force) || (req.query && req.query.force === "1"));

  try {
    const result = await ingestPlates(orderId, token, { force });
    // A partial failure answers 502 with the full summary attached: the caller
    // sees exactly which image failed, and retrying re-does only that one.
    res.status(result.ok ? 200 : 502).json(result);
  } catch (e) {
    const status = e instanceof MagnificError ? e.status : 500;
    console.error("[plates]", status, e.message);
    res.status(status).json({ ok: false, error: e.message });
  }
}
