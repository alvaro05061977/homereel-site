// Vercel serverless function: send one room back through its own node.
//
// POST /api/rerun  { record: "recXXXXXXXXXXXXXX", gate?: "keyframe"|"clip", force?: true }
// GET  /api/rerun?record=recXXXXXXXXXXXXXX&gate=clip&k=<QC_KEY>
//   → { ok, ran, nodeName, runId, credits, backTo }  |  409 { refused: "..." }
//
// NORMALLY YOU DO NOT CALL THIS. Saving a "Re-run" verdict in the QC viewer
// already triggers it through lib/gates.js, which is the point — a reviewer
// rejects a render and the redraw starts by itself.
//
// This endpoint exists for the case the doorbell was missed: a render that
// failed outright, or a re-run that did not start because Magnific was briefly
// unreachable. `force: true` skips the "the verdict must say Re-run" check for
// exactly that situation.
//
// IT SPENDS MONEY — 100 credits for a keyframe, 3,950 for a clip — so it carries
// the same guards as api/produce: paid, a board to run on, the node priced by
// Magnific first, and ORDER_BUDGET_CREDITS. A refusal is a 409 with the reason.
//
// Env vars:
//   QC_KEY          required — the same shared secret the QC viewer uses
//   AIRTABLE_TOKEN  required
//   ORDER_BUDGET_CREDITS  optional, default 45,000
//   MAGNIFIC_*      read by lib/magnific.js

import { rerunRoom } from "../lib/rerun.js";
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
  const recordId = String(q.record || b.record || "");
  const gate = String(q.gate || b.gate || "keyframe") === "clip" ? "clip" : "keyframe";
  // Explicit either way round: easy to ask for, impossible to trigger by accident.
  const force = q.force === "1" || b.force === true;

  try {
    const result = await rerunRoom(recordId, gate, token, { force });
    res.status(result.refused ? 409 : 200).json(result);
  } catch (e) {
    const status = e instanceof MagnificError ? e.status : 500;
    console.error("[rerun]", status, e.message);
    res.status(status).json({ ok: false, error: e.message });
  }
}
