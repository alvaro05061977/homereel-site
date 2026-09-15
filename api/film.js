// Vercel serverless function: a permanent link to a delivered film.
//
// GET /api/film?order=recXXXXXXXXXXXXXX&k=<QC_KEY>[&format=16x9|9x16][&info=1]
//   → 302 redirect to the film itself
//   → with &info=1, JSON describing what it would redirect to (for checking)
//
// WHY THIS EXISTS. Every direct media URL in this system expires. Magnific's
// pikaso links die within days; Airtable's attachment links are signed and
// short-lived too. A link emailed to a realtor has to still work next month, so
// it cannot BE one of those URLs — it has to be a link that goes and fetches a
// fresh one each time it is clicked.
//
// Airtable re-signs an attachment's URL on every API read. So this handler
// reads the order fresh, takes the current URL, and redirects. The client's
// link never changes and never dies. Same fix as storing a Magnific creation id
// instead of a signed URL: keep the NAME, resolve the address on demand.
//
// ⚠ THE KEY IS NOT AUTHENTICATION. `k` is one shared secret. Anyone holding a
// link holds the key. That is acceptable for sending a film to the client who
// paid for it, and it is NOT acceptable as a login: do not describe it to a
// client as secure, and do not reuse this pattern for anything that should be
// private per person. A real client delivery page (Phase 2) needs a per-order
// token, not this.
//
// Env vars: QC_KEY (required), AIRTABLE_TOKEN (required).

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const ORDERS = "Orders";

const F = {
  finishedFilm: "Finished Film",
  jobNumber: "Job #",
  listing: "Listing / Order",
};

// Which attachment is "the" film?
//
// The field holds every candidate and final ever attached — HR-0005 has six,
// including a rejected 9:16 experiment whose filename says NOT-FOR-DELIVERY.
// Picking wrongly would send a client a reject, so the rules are deliberately
// strict and it refuses rather than guesses:
//
//   1. drop anything whose name says it is not for delivery
//   2. keep only the requested shape (16x9 by default)
//   3. prefer names containing FINAL over candidates and drafts
//   4. among those, take the LAST — Airtable appends, so the newest is last
//
// This is a heuristic over filenames, which is fragile. The right fix is a
// dedicated "Delivered 16:9" / "Delivered 9:16" attachment field holding one
// file each. Do that before this is pointed at a real client.
function pickFilm(attachments, format) {
  if (!Array.isArray(attachments) || !attachments.length) return null;
  const tag = format === "9x16" ? "9x16" : "16x9";

  const named = attachments.filter((a) => typeof a.filename === "string");
  const deliverable = named.filter((a) => !/NOT[-_ ]?FOR[-_ ]?DELIVERY|EXPERIMENT|REJECT/i.test(a.filename));
  const rightShape = deliverable.filter((a) => a.filename.includes(tag));
  if (!rightShape.length) return null;

  const finals = rightShape.filter((a) => /FINAL/i.test(a.filename));
  const pool = finals.length ? finals : rightShape;
  return pool[pool.length - 1];
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const qcKey = process.env.QC_KEY;
  if (!qcKey) { res.status(503).json({ error: "QC_KEY is not set; this endpoint stays closed until it is." }); return; }
  if (((req.query && req.query.k) || "") !== qcKey) { res.status(401).json({ error: "Unauthorized." }); return; }

  const token = process.env.AIRTABLE_TOKEN;
  if (!token) { res.status(500).json({ error: "Server not configured." }); return; }

  const orderId = String((req.query && req.query.order) || "");
  if (!/^rec[a-zA-Z0-9]{14}$/.test(orderId)) {
    res.status(400).json({ error: "Missing or malformed order id." }); return;
  }
  const format = String((req.query && req.query.format) || "16x9");
  const info = (req.query && req.query.info) === "1";

  try {
    const r = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(ORDERS)}/${orderId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) {
      res.status(r.status === 404 ? 404 : 502).json({ error: `Could not read the order (${r.status}).` });
      return;
    }
    const order = await r.json();
    const film = pickFilm(order.fields?.[F.finishedFilm], format);

    if (!film) {
      // A plain 404 would look like a broken link. Say which shape is missing,
      // because "the 9:16 is not made yet" is a normal state, not a fault.
      res.status(404).json({
        error: `No ${format} film is attached to this order yet.`,
        job: order.fields?.[F.jobNumber] || null,
        listing: order.fields?.[F.listing] || null,
      });
      return;
    }

    if (info) {
      res.status(200).json({
        ok: true,
        job: order.fields?.[F.jobNumber] || null,
        listing: order.fields?.[F.listing] || null,
        format,
        filename: film.filename,
        bytes: film.size ?? null,
        type: film.type ?? null,
      });
      return;
    }

    // 302, not 301. The target changes every time by design, so this must
    // never be cached as permanent — and no-store keeps an expired signed URL
    // out of the browser's cache.
    res.setHeader("Cache-Control", "no-store");
    res.redirect(302, film.url);
  } catch (e) {
    console.error("[film]", String(e));
    res.status(500).json({ error: "Unexpected error." });
  }
}
