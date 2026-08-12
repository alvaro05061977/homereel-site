// Vercel serverless function: the QC viewer's data layer.
//
// GET  /api/qc?order=recXXXXXXXXXXXXXX
//        → { order: {id, address, agent, productionStatus}, rooms: [...] }
// POST /api/qc   { recordId, gate: "keyframe"|"clip", verdict, notes?, trimIn?, trimOut? }
//        → { ok: true }
//
// WHY this exists: Airtable interfaces render attachments as ~160px thumbnails.
// A reviewer cannot judge whether a room's furniture changed at that size, and
// Gate 1 gates ~3,500 credits per clip. This endpoint feeds a full-screen
// comparison page (qc.html) that shows the client's photo and the composed
// keyframe at real size, synchronised, with a wipe handle.
//
// Env vars required (already set for /api/order):
//   AIRTABLE_TOKEN - Airtable personal access token
// Optional:
//   QC_KEY - if set, every request must carry ?k=<QC_KEY>. Leave unset only for
//            internal testing; the listing photos are client property.

import { syncApprovedKeyframe } from "../lib/canvas-core.js";

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const ORDERS = "Orders";
const ORDER_PHOTOS = "Order Photos";

const F = {
  photo: "Photo",
  roomType: "Room Type",
  slot: "Slot Order",
  order: "Order",
  sourceUrl: "Cloudinary URL",
  keyframeUrl: "Keyframe URL",
  keyframeVerdict: "Keyframe Verdict",
  clipUrl: "Clip URL",
  clipVerdict: "Clip Verdict",
  trimIn: "Trim In (s)",
  trimOut: "Trim Out (s)",
  notes: "QC Notes",
};

const KEYFRAME_VERDICTS = ["Pending", "Approved", "Re-run"];
const CLIP_VERDICTS = ["Pending", "Approved", "Trim", "Re-run"];

function at(path, token, init = {}) {
  return fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

// Pull every Order Photos row, then keep the ones linked to this order.
// The link field holds record IDs, which filterByFormula can't match directly —
// and the table is small enough that a full read is cheaper than being clever.
async function fetchRooms(token, orderId) {
  const rows = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: "100" });
    if (offset) qs.set("offset", offset);
    const r = await at(`${encodeURIComponent(ORDER_PHOTOS)}?${qs}`, token);
    if (!r.ok) throw new Error(`Airtable ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const d = await r.json();
    rows.push(...d.records);
    offset = d.offset;
  } while (offset);

  return rows
    .filter((rec) => (rec.fields[F.order] || []).includes(orderId))
    .map((rec) => ({
      id: rec.id,
      label: rec.fields[F.photo] || "",
      room: rec.fields[F.roomType] || "Room",
      slot: rec.fields[F.slot] ?? 999,
      sourceUrl: rec.fields[F.sourceUrl] || "",
      keyframeUrl: rec.fields[F.keyframeUrl] || "",
      keyframeVerdict: rec.fields[F.keyframeVerdict] || "Pending",
      clipUrl: rec.fields[F.clipUrl] || "",
      clipVerdict: rec.fields[F.clipVerdict] || "Pending",
      trimIn: rec.fields[F.trimIn] ?? null,
      trimOut: rec.fields[F.trimOut] ?? null,
      notes: rec.fields[F.notes] || "",
    }))
    .sort((a, b) => a.slot - b.slot);
}

export default async function handler(req, res) {
  const token = process.env.AIRTABLE_TOKEN;
  if (!token) { res.status(500).json({ error: "Server not configured." }); return; }

  const qcKey = process.env.QC_KEY;
  if (qcKey) {
    const supplied = (req.query && req.query.k) || (req.body && req.body.k) || "";
    if (supplied !== qcKey) { res.status(401).json({ error: "Unauthorized." }); return; }
  }

  try {
    if (req.method === "GET") {
      const orderId = String((req.query && req.query.order) || "");
      if (!/^rec[a-zA-Z0-9]{14}$/.test(orderId)) {
        res.status(400).json({ error: "Missing or malformed order id." }); return;
      }

      const oRes = await at(`${encodeURIComponent(ORDERS)}/${orderId}`, token);
      if (!oRes.ok) { res.status(404).json({ error: "Order not found." }); return; }
      const o = await oRes.json();

      const rooms = await fetchRooms(token, orderId);
      res.status(200).json({
        order: {
          id: orderId,
          address: o.fields["Listing / Order"] || "",
          agent: o.fields["Agent Name"] || "",
          brokerage: o.fields["Brokerage"] || "",
          productionStatus: o.fields["Production Status"] || "",
          creditsSpent: o.fields["Credits Spent"] ?? 0,
        },
        rooms,
      });
      return;
    }

    if (req.method === "POST") {
      const b = req.body || {};
      const recordId = String(b.recordId || "");
      if (!/^rec[a-zA-Z0-9]{14}$/.test(recordId)) {
        res.status(400).json({ error: "Missing or malformed record id." }); return;
      }

      const gate = b.gate === "clip" ? "clip" : "keyframe";
      const fields = {};

      if (b.verdict !== undefined) {
        const allowed = gate === "clip" ? CLIP_VERDICTS : KEYFRAME_VERDICTS;
        if (!allowed.includes(b.verdict)) {
          res.status(400).json({ error: `Verdict must be one of: ${allowed.join(", ")}` }); return;
        }
        fields[gate === "clip" ? F.clipVerdict : F.keyframeVerdict] = b.verdict;
      }

      if (typeof b.notes === "string") fields[F.notes] = b.notes.slice(0, 5000);

      // Trim seconds only mean anything on the clip gate.
      if (gate === "clip") {
        if (b.trimIn !== undefined && b.trimIn !== null && b.trimIn !== "") {
          const n = Number(b.trimIn);
          if (!Number.isFinite(n) || n < 0) { res.status(400).json({ error: "Trim In must be a positive number." }); return; }
          fields[F.trimIn] = n;
        }
        if (b.trimOut !== undefined && b.trimOut !== null && b.trimOut !== "") {
          const n = Number(b.trimOut);
          if (!Number.isFinite(n) || n < 0) { res.status(400).json({ error: "Trim Out must be a positive number." }); return; }
          fields[F.trimOut] = n;
        }
      }

      if (!Object.keys(fields).length) { res.status(400).json({ error: "Nothing to update." }); return; }

      const r = await at(`${encodeURIComponent(ORDER_PHOTOS)}/${recordId}`, token, {
        method: "PATCH",
        body: JSON.stringify({ fields, typecast: true }),
      });
      if (!r.ok) {
        console.error("qc PATCH failed:", r.status, (await r.text()).slice(0, 300));
        res.status(502).json({ error: "Could not save that verdict. Try again." }); return;
      }

      // The verdict is saved; that part is now safe regardless of what follows.
      //
      // An APPROVED keyframe goes straight onto the client's Magnific canvas,
      // wired as that room's animation first frame. This is the instant path:
      // the approval already came through us, so nothing has to poll or notify.
      // Failure here NEVER fails the request - losing a reviewer's verdict
      // because a canvas was unreachable would be much worse than a canvas
      // that is briefly out of date, and /api/canvas-sync can replay it.
      let canvas = null;
      if (gate === "keyframe" && b.verdict === "Approved") {
        try {
          canvas = await syncApprovedKeyframe(recordId, token);
        } catch (e) {
          console.error("qc: canvas sync failed (verdict was still saved):", String(e));
          canvas = { synced: false, error: String(e.message || e) };
        }
      }

      res.status(200).json({ ok: true, ...(canvas ? { canvas } : {}) });
      return;
    }

    res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    console.error("qc: unexpected error:", String(e));
    res.status(500).json({ error: "Unexpected error." });
  }
}
