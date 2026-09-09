// lib/plates.js — put an order's images into Magnific the moment it is paid.
//
// "Plates" are the client's own pictures: the six (or eight, or twelve) listing
// photos, the agent's headshot and the brokerage logo. Until they exist inside
// Magnific as CREATIONS, nothing downstream can run — a COMPOSE node holds a
// creation identifier, not a URL, and the end card needs the headshot and logo
// as creations too.
//
// Doing this at payment rather than at production time is deliberate: it is the
// slowest step that needs no judgement, so it should happen while the client is
// still reading the thank-you page, not while a gate email is waiting on it.
//
// WHY WE STORE THE IDENTIFIER AND NOT THE URL. Every signed URL in this system
// has burned us: pikaso links die about 24 hours after the render, which is what
// left Gate 1 showing broken images on HR-0005 through most of August. A creation
// identifier never expires. Ask Magnific for a fresh URL at the moment you need
// one (lib/magnific.js `creationGet`) and the problem cannot come back.
//
// IDEMPOTENT BY DESIGN. Every row that already carries an identifier is skipped,
// so a Stripe retry, a double-click, or a second call from api/produce costs
// nothing and changes nothing. Uploads are free; even so, doing them twice would
// leave duplicate creations cluttering the library.

import { openSession, uploadFromUrl, MagnificError } from "./magnific.js";

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const ORDERS = "Orders";
const ORDER_PHOTOS = "Order Photos";

const F = {
  // Orders
  orderLabel: "Listing / Order",
  jobNumber: "Job #",
  headshot: "Realtor Headshot",
  logo: "Logo",
  headshotId: "Headshot Creation ID",
  logoId: "Logo Creation ID",
  productionLog: "Production Log",
  // Order Photos
  photoLabel: "Photo",
  order: "Order",
  slot: "Slot Order",
  roomType: "Room Type",
  cloudinaryUrl: "Cloudinary URL",
  sourcePhoto: "Source Photo",
  creationId: "Magnific Creation ID",
};

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

async function atJson(path, token, init) {
  const r = await at(path, token, init);
  if (!r.ok) throw new MagnificError(502, `Airtable ${path} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Airtable re-signs attachment URLs on every API read, so the URL in a row we
// just fetched is fresh for as long as this request lasts — long enough for
// Magnific to copy the bytes.
function attachmentUrl(cell) {
  if (!Array.isArray(cell) || !cell.length) return "";
  const a = cell[0];
  return a.url || (a.thumbnails && a.thumbnails.full && a.thumbnails.full.url) || "";
}

// Same approach as api/qc.js: the link field holds record IDs, which
// filterByFormula cannot match directly, and the table is small enough that a
// full read beats being clever.
async function fetchRooms(token, orderId) {
  const rows = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: "100" });
    if (offset) qs.set("offset", offset);
    const d = await atJson(`${encodeURIComponent(ORDER_PHOTOS)}?${qs}`, token);
    rows.push(...d.records);
    offset = d.offset;
  } while (offset);

  return rows
    .filter((rec) => (rec.fields[F.order] || []).includes(orderId))
    .sort((a, b) => (a.fields[F.slot] ?? 999) - (b.fields[F.slot] ?? 999));
}

// The Production Log is a JSON-lines journal, appended never rewritten. Read
// first so a concurrent writer's line is not lost — and if the append itself
// fails, say so and carry on: a missing log line must never cost us an upload
// that already happened.
async function appendLog(token, orderId, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try {
    const rec = await atJson(`${encodeURIComponent(ORDERS)}/${orderId}`, token);
    const existing = rec.fields?.[F.productionLog] || "";
    await atJson(`${encodeURIComponent(ORDERS)}/${orderId}`, token, {
      method: "PATCH",
      body: JSON.stringify({ fields: { [F.productionLog]: existing ? `${existing}\n${line}` : line } }),
    });
  } catch (e) {
    console.error("[plates] production log append failed (work still done):", String(e));
  }
}

// Ingest every image on an order that is not already in Magnific.
//
// Returns a summary rather than throwing on a single bad image: one unreadable
// photo should not stop the other seven, and the caller decides whether a
// partial result is worth retrying. Only a failure that makes the whole order
// unreadable (no such order, Airtable down, Magnific auth broken) throws.
export async function ingestPlates(orderId, airtableToken, { force = false } = {}) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(orderId || ""))) {
    throw new MagnificError(400, "orderId (an Orders record id) is required");
  }
  if (!airtableToken) throw new MagnificError(503, "AIRTABLE_TOKEN is not configured");

  const order = await atJson(`${encodeURIComponent(ORDERS)}/${orderId}`, airtableToken);
  const of = order.fields || {};
  const rooms = await fetchRooms(airtableToken, orderId);

  // Build the work list before opening a session, so an order that is already
  // done costs one Airtable read and no Magnific call at all.
  const jobs = [];

  for (const room of rooms) {
    const rf = room.fields || {};
    const existing = String(rf[F.creationId] || "").trim();
    const url = rf[F.cloudinaryUrl] || attachmentUrl(rf[F.sourcePhoto]);
    const label = rf[F.photoLabel] || rf[F.roomType] || room.id;
    if (existing && !force) {
      jobs.push({ kind: "room", id: room.id, label, skipped: "already ingested", creationId: existing });
      continue;
    }
    if (!url) {
      jobs.push({ kind: "room", id: room.id, label, error: "no Cloudinary URL and no Source Photo attachment" });
      continue;
    }
    jobs.push({ kind: "room", id: room.id, label, url });
  }

  for (const [field, idField, label] of [
    [F.headshot, F.headshotId, "headshot"],
    [F.logo, F.logoId, "logo"],
  ]) {
    const existing = String(of[idField] || "").trim();
    if (existing && !force) {
      jobs.push({ kind: "order", idField, label, skipped: "already ingested", creationId: existing });
      continue;
    }
    const url = attachmentUrl(of[field]);
    // A missing logo is normal — the wizard does not require one. A missing
    // headshot is not, because the end card needs it, but it is not this step's
    // job to refuse the order over it. Flag it and move on.
    if (!url) {
      jobs.push({ kind: "order", idField, label, skipped: `no ${label} on the order` });
      continue;
    }
    jobs.push({ kind: "order", idField, label, url });
  }

  const todo = jobs.filter((j) => j.url);
  if (!todo.length) {
    return summarise(jobs, { orderId, order: of, uploaded: 0, alreadyDone: true });
  }

  // One session, one token refresh, all uploads in parallel.
  const session = await openSession();
  await Promise.all(
    todo.map(async (job) => {
      try {
        job.creationId = await uploadFromUrl(job.url, { session });
      } catch (e) {
        job.error = String(e.message || e);
      }
    })
  );

  // Write the identifiers back. Rooms go in one batch (Airtable takes 10 per
  // request); the order's two fields go in one PATCH.
  const roomWrites = todo.filter((j) => j.kind === "room" && j.creationId);
  for (let i = 0; i < roomWrites.length; i += 10) {
    const chunk = roomWrites.slice(i, i + 10);
    try {
      await atJson(encodeURIComponent(ORDER_PHOTOS), airtableToken, {
        method: "PATCH",
        body: JSON.stringify({
          records: chunk.map((j) => ({ id: j.id, fields: { [F.creationId]: j.creationId } })),
          typecast: true,
        }),
      });
    } catch (e) {
      // The upload happened; only the bookkeeping failed. Mark it so a retry
      // re-uploads rather than silently leaving a room with no identifier.
      for (const j of chunk) j.error = `uploaded ${j.creationId} but Airtable write failed: ${String(e.message || e)}`;
    }
  }

  const orderFields = {};
  for (const j of todo) {
    if (j.kind === "order" && j.creationId) orderFields[j.idField] = j.creationId;
  }
  if (Object.keys(orderFields).length) {
    try {
      await atJson(`${encodeURIComponent(ORDERS)}/${orderId}`, airtableToken, {
        method: "PATCH",
        body: JSON.stringify({ fields: orderFields, typecast: true }),
      });
    } catch (e) {
      for (const j of todo) {
        if (j.kind === "order" && j.creationId) j.error = `uploaded ${j.creationId} but Airtable write failed: ${String(e.message || e)}`;
      }
    }
  }

  const result = summarise(jobs, { orderId, order: of, uploaded: todo.filter((j) => j.creationId && !j.error).length });

  await appendLog(airtableToken, orderId, {
    level: result.errors.length ? "error" : "info",
    event: "plates:ingested",
    detail: {
      uploaded: result.uploaded,
      skipped: result.skipped,
      failed: result.errors.length,
      // Uploads cost nothing. Recorded so the credit column is never puzzled
      // over later: this step is free, every time.
      credits: 0,
      ...(result.errors.length ? { errors: result.errors } : {}),
    },
  });

  return result;
}

function summarise(jobs, { orderId, order, uploaded, alreadyDone = false }) {
  const errors = jobs.filter((j) => j.error).map((j) => ({ label: j.label, error: j.error }));
  return {
    ok: errors.length === 0,
    orderId,
    job: order[F.jobNumber] || null,
    listing: order[F.orderLabel] || null,
    uploaded,
    skipped: jobs.filter((j) => j.skipped).length,
    failed: errors.length,
    alreadyDone,
    items: jobs.map((j) => ({
      label: j.label,
      creationId: j.creationId || null,
      ...(j.skipped ? { skipped: j.skipped } : {}),
      ...(j.error ? { error: j.error } : {}),
    })),
    errors,
  };
}
