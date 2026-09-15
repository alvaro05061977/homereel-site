// Vercel serverless function: start an order's renders — or refuse, and say why.
//
// POST /api/produce  { order: "recXXXXXXXXXXXXXX", stage?: "keyframes"|"clips", dryRun?: true }
// GET  /api/produce?order=recXXXXXXXXXXXXXX&stage=keyframes&dry=1&k=<QC_KEY>
//   → { ok, ran, refused?, budget: { estimate, alreadySpent, projected, budget }, ... }
//
// This is the only endpoint that can make Magnific spend money, so read
// lib/produce.js before changing anything here: the refusals are the feature.
//
// `dryRun` runs every check and reports what the stage would cost without
// spending a credit or moving the order. Use it freely.
//
// HTTP meanings:
//   200 ran            — a stage was started
//   200 ok, ran:false  — every guard passed but the board could not be run:
//                        no Magnific Space ID on the order, a room with no
//                        matching node, or a node that prices wrong. The body
//                        says which. Nothing was spent and nothing changed.
//   409 refused        — a guard said no. The body says which one and why.
//
// Env vars:
//   QC_KEY                 required — shared secret
//   AIRTABLE_TOKEN         required
//   ORDER_BUDGET_CREDITS   optional, default 45,000. THE circuit-breaker:
//                          Magnific auto top-up is on, so nothing else stops a
//                          runaway from simply buying more credits.
//
// No Flow env vars. Renders are driven node by node on the order's own Space
// (lib/space.js) because a Flow runs a whole board in one go and this pipeline
// must stop at both QC gates. The only thing the order needs is its
// `Magnific Space ID`.

import { startOrder } from "../lib/produce.js";
import { MagnificError } from "../lib/magnific.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const qcKey = process.env.QC_KEY;
  if (!qcKey) {
    res.status(503).json({ error: "QC_KEY is not set; this endpoint stays closed until it is." });
    return;
  }
  const supplied = (req.query && req.query.k) || (req.body && req.body.k) || "";
  if (supplied !== qcKey) { res.status(401).json({ error: "Unauthorized." }); return; }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) { res.status(500).json({ error: "Server not configured." }); return; }

  const q = req.query || {};
  const b = req.body || {};
  const orderId = String(q.order || b.order || "");
  const stage = String(q.stage || b.stage || "keyframes");
  // A dry run must be easy to ask for and impossible to trigger by accident,
  // hence an explicit flag either way round.
  const dryRun = q.dry === "1" || b.dryRun === true;
  const force = q.force === "1" || b.force === true;

  try {
    const result = await startOrder(orderId, token, { stage, dryRun, force });
    res.status(result.refused ? 409 : 200).json(result);
  } catch (e) {
    const status = e instanceof MagnificError ? e.status : 500;
    console.error("[produce]", status, e.message);
    res.status(status).json({ ok: false, error: e.message });
  }
}
