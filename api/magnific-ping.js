// Vercel serverless function: is the Magnific machine login alive from Vercel?
//
// GET /api/magnific-ping?k=<QC_KEY>
//   → { ok: true, plan, credits: { available, spent, totalPlan }, config: {...} }
//
// This is the acceptance test for lib/magnific.js (build spec P1.1). It is the
// only Magnific call that costs nothing, so it is the right health check: if
// this returns a balance, the OAuth recipe, the MCP transport and the env vars
// are all good, and any later failure is about the tool being called, not auth.
//
// NOT named with a leading underscore, deliberately: Vercel's /api convention
// treats underscore-prefixed files as helpers rather than routes, and a health
// check that cannot be reached is not a health check.
//
// SECURITY: unlike api/qc.js, the key here is REQUIRED. api/qc.js treats an
// unset QC_KEY as "internal testing" and serves everything, which is exactly how
// the QC endpoint sat open to the world until 2026-09-08. This one refuses to
// answer at all until the variable is set, so it can never repeat that.
//
// Env vars:
//   QC_KEY                        required — shared secret, same one the QC viewer uses
//   MAGNIFIC_OAUTH_CLIENT_ID      \
//   MAGNIFIC_REFRESH_TOKEN         > read by lib/magnific.js
//   MAGNIFIC_OAUTH_CLIENT_SECRET  /  (omit for a public client)

import { accountBalance, MagnificError } from "../lib/magnific.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const qcKey = process.env.QC_KEY;
  if (!qcKey) {
    res.status(503).json({ error: "QC_KEY is not set; this endpoint stays closed until it is." });
    return;
  }
  if (((req.query && req.query.k) || "") !== qcKey) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }

  // Presence only. Never the values.
  const config = {
    clientId: Boolean(process.env.MAGNIFIC_OAUTH_CLIENT_ID),
    refreshToken: Boolean(process.env.MAGNIFIC_REFRESH_TOKEN),
    clientSecret: Boolean(process.env.MAGNIFIC_OAUTH_CLIENT_SECRET),
    airtableToken: Boolean(process.env.AIRTABLE_TOKEN),
  };

  try {
    const bal = await accountBalance();
    const credits = bal?.credits || {};
    res.status(200).json({
      ok: true,
      plan: bal?.plan?.productName || bal?.plan?.tier || null,
      credits: {
        available: credits.available ?? null,
        spent: credits.spent ?? null,
        totalPlan: credits.totalPlan ?? null,
      },
      config,
      // Kept raw as well: the shape of account_balance is read off the tool
      // description, not off a live call from here. Drop this once it is seen.
      raw: bal,
    });
  } catch (err) {
    const status = err instanceof MagnificError ? err.status : 500;
    console.error("[magnific-ping]", status, err.message);
    res.status(status).json({ ok: false, error: err.message, config });
  }
}
