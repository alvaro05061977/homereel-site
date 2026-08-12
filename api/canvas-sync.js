// Vercel serverless function: manual / external trigger for pushing an
// APPROVED keyframe onto the client's Magnific canvas.
//
// POST /api/canvas-sync   { recordId: "recXXXXXXXXXXXXXX" }
//   headers: x-canvas-sync-key: <CANVAS_SYNC_KEY>
//   → 202 { ok, synced, room, spaceId, operationId }
//
// ⚠ THIS IS NOT THE PRIMARY PATH. In normal operation the sync fires from
// api/qc.js the instant a reviewer approves a room in the QC dashboard —
// the approval already passes through our own server, so nothing needs to
// tell us about it. (Driving this from an Airtable automation would have
// needed the "Run script" action, which is a paid-plan feature.)
//
// Keep this endpoint for: re-syncing a room by hand, back-filling a canvas
// after a failure, and testing the Magnific credential without touching a
// real verdict.
//
// Env vars: CANVAS_SYNC_KEY, AIRTABLE_TOKEN, plus the Magnific OAuth vars
// documented in lib/canvas-core.js.

import { syncApprovedKeyframe, CanvasSyncError } from "../lib/canvas-core.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const expected = process.env.CANVAS_SYNC_KEY;
  if (!expected) return res.status(503).json({ error: "CANVAS_SYNC_KEY is not set — refusing to run unauthenticated" });
  if (req.headers["x-canvas-sync-key"] !== expected) return res.status(401).json({ error: "Bad or missing x-canvas-sync-key" });

  const airtableToken = process.env.AIRTABLE_TOKEN;
  if (!airtableToken) return res.status(503).json({ error: "AIRTABLE_TOKEN is not set" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const result = await syncApprovedKeyframe(body.recordId, airtableToken);
    return res.status(202).json({ ok: true, ...result });
  } catch (err) {
    const status = err instanceof CanvasSyncError ? err.status : 500;
    if (status >= 500) console.error("[canvas-sync] FAILED", err);
    return res.status(status).json({ error: err.message });
  }
}
