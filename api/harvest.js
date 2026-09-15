// Vercel serverless function: collect the renders and open the gate.
//
// POST /api/harvest  { order: "recXXXXXXXXXXXXXX", stage?: "keyframes"|"clips" }
// GET  /api/harvest?order=recXXXXXXXXXXXXXX&k=<QC_KEY>
//   → { ok, rooms, harvested, have, stillRunning, failed, complete, movedTo?, items: [...] }
//
// GET  /api/harvest?k=<QC_KEY>            — NO order: sweeps EVERY order that is
//                                           mid-render and collects all of them
//   → { ok, sweep:true, rendering, opened, stillRunning, orders: [...] }
//
// The sweep is the address to point a clock at. It takes no arguments and asks
// Airtable which orders are rendering, so nothing has to keep a list. This
// project ships zero-config functions — no vercel.json, so no Vercel cron — and
// the sweep is what makes any outside scheduler a one-line job.
//
// api/produce starts the nodes and lets go. This picks the results up, files
// each one on its room's row, and — only when EVERY room is in — moves the
// order to QC Keyframes or QC Clips, which is what makes the gate email fire.
//
// SAFE TO CALL AS OFTEN AS YOU LIKE. It spends nothing. A room still rendering
// comes back as "running" and the order is left exactly where it was; call
// again in a minute. Calling it twice after everything is in just rewrites the
// same rows with the same renders.
//
// `stage` is optional and is normally left out: it is read from the order's own
// Production Status. Pass it only to force a re-collection of a stage the order
// has already moved past.
//
// HTTP meanings:
//   200 ok, complete:true   — everything is in; the order moved and the gate is open
//   200 ok, complete:false  — some rooms are still rendering (or one failed).
//                             Nothing moved. This is normal, not an error.
//   200 ok:false            — the order is not at a rendering stage, so there is
//                             nothing to collect. The body says where it is.
//
// Env vars:
//   QC_KEY          required — the same shared secret the QC viewer uses
//   AIRTABLE_TOKEN  required
//   MAGNIFIC_*      read by lib/magnific.js

import { harvestOrder, harvestAll } from "../lib/harvest.js";
import { MagnificError } from "../lib/magnific.js";
import { selfUrl } from "../lib/self-url.js";

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  // Required, never optional — the same rule as api/plates and api/produce.
  // api/qc.js once read an unset key as "internal testing" and served
  // everything, which is how it sat open to the world until 2026-09-08.
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
  const stage = String(q.stage || b.stage || "") || undefined;
  // ?debug=1 adds the raw reply Magnific sent for any room still reported as
  // running. Diagnostic only; it changes nothing and spends nothing.
  const debug = q.debug === "1" || b.debug === true;

  try {
    const result = orderId
      ? await harvestOrder(orderId, token, { stage, base: selfUrl(req), debug })
      : await harvestAll(token, { base: selfUrl(req) });
    res.status(200).json(result);
  } catch (e) {
    const status = e instanceof MagnificError ? e.status : 500;
    console.error("[harvest]", status, e.message);
    res.status(status).json({ ok: false, error: e.message });
  }
}
