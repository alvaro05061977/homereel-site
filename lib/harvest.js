// lib/harvest.js — collect what the renders produced, and open the gate.
//
// api/produce starts one node per room and walks away, because a clip takes
// minutes and a serverless function has seconds. Each room's run identifier is
// left on its own row (Order Photos → Run ID). This is the other half: read
// those run ids back, put the finished render on the room's row, and — once
// EVERY room is in — move the order's Production Status so the QC email fires.
//
// WHY IT IS SEPARATE FROM produce. Produce is the only thing that spends money
// and is written almost entirely out of refusals. Harvest spends nothing and is
// safe to call as often as you like: re-running it just rewrites the same rows
// with the same renders. That difference in risk is worth a file boundary.
//
// IT NEVER JUDGES A RENDER. It files what came out and opens the gate. A human
// decides whether the picture is any good, at Gate 1 and again at Gate 2.
//
// SAFE TO CALL EARLY. A room still rendering is not an error — it reports
// "running" and the order's status is left alone. Call it again in a minute.

import { openSession, creationGet, MagnificError } from "./magnific.js";
import { waitRun } from "./space.js";

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const ORDERS = "Orders";
const ORDER_PHOTOS = "Order Photos";

const F = {
  // Orders
  orderLabel: "Listing / Order",
  jobNumber: "Job #",
  productionStatus: "Production Status",
  productionLog: "Production Log",
  keyframesDoneAt: "Keyframes Done At",
  clipsDoneAt: "Clips Done At",
  // Order Photos
  order: "Order",
  photoLabel: "Photo",
  slot: "Slot Order",
  runId: "Run ID",
  status: "Status",
  keyframeUrl: "Keyframe URL",
  keyframeFile: "Keyframe",
  clipUrl: "Clip URL",
  clipFile: "Clip",
};

// What each stage collects, where it files it, and where it leaves the order.
const STAGE = {
  keyframes: {
    from: "Rendering Keyframes",
    urlField: F.keyframeUrl,
    fileField: F.keyframeFile,
    nextStatus: "QC Keyframes",
    stopwatch: F.keyframesDoneAt,
    // ⚠ Order Photos.Status is a singleSelect whose ONLY options are
    // uploaded / composed / approved / ingested. "composed" is the right word
    // for a rendered keyframe; there is no option that fits a rendered clip, so
    // the clip stage leaves Status alone rather than invent one. See the note
    // on typecast below — this is not a detail to improvise on.
    rowStatus: "composed",
    noun: "keyframe",
  },
  clips: {
    from: "Rendering Clips",
    urlField: F.clipUrl,
    fileField: F.clipFile,
    nextStatus: "QC Clips",
    stopwatch: F.clipsDoneAt,
    rowStatus: null,          // no existing option fits; leave Status untouched
    noun: "clip",
  },
};

const nameOf = (cell) => (cell && typeof cell === "object" ? cell.name : cell) || "";

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
    console.error("[harvest] production log append failed:", String(e));
  }
}

// ---- reading a creation's URL --------------------------------------------
//
// ⚠ `creations_get` answers in JSON on some calls and TOON on others, and
// lib/magnific.js hands TOON back untouched as { text }. Both shapes are
// handled. The TOON case is read with a line-anchored match on the TOP-LEVEL
// `url:` — the media collection further down repeats `url:` for every
// reference frame, preview grid and audio track, all of them indented, so
// anchoring to column zero is what keeps us from filing a reference image as
// the finished clip.
export function creationUrl(res) {
  if (res && typeof res.url === "string" && res.url) return res.url;
  const text = typeof res === "string" ? res : res?.text;
  if (typeof text === "string") {
    const m = text.match(/^url:\s*"?([^"\n]+)"?\s*$/m);
    if (m) return m[1].trim();
  }
  return null;
}

export function creationStatus(res) {
  if (res && typeof res.status === "string") return res.status;
  const text = typeof res === "string" ? res : res?.text;
  const m = typeof text === "string" ? text.match(/^status:\s*"?([A-Za-z_-]+)"?\s*$/m) : null;
  return m ? m[1] : null;
}

/**
 * Collect one stage of renders for one order.
 *
 * @param stage  "keyframes" or "clips". Omit and it is read from the order's
 *               Production Status, which is what a cron or a doorbell wants.
 * @param base   this request's own host, for ringing the next endpoint.
 *               NEVER process.env.VERCEL_URL — see lib/self-url.js.
 */
export async function harvestOrder(orderId, airtableToken, { stage, base, debug = false } = {}) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(orderId || ""))) {
    throw new MagnificError(400, "orderId (an Orders record id) is required");
  }
  if (!airtableToken) throw new MagnificError(503, "AIRTABLE_TOKEN is not configured");

  const order = await atJson(`${encodeURIComponent(ORDERS)}/${orderId}`, airtableToken);
  const of = order.fields || {};
  const productionStatus = nameOf(of[F.productionStatus]);

  if (!stage) {
    stage = Object.keys(STAGE).find((s) => STAGE[s].from === productionStatus);
  }
  const plan = STAGE[stage];
  if (!plan) {
    return {
      orderId,
      job: of[F.jobNumber] || null,
      ok: false,
      harvested: 0,
      reason:
        `Nothing to collect. This order is at "${productionStatus || "(empty)"}", ` +
        'and harvesting only applies while it is at "Rendering Keyframes" or "Rendering Clips". ' +
        "Pass stage explicitly to override.",
    };
  }

  const context = { orderId, job: of[F.jobNumber] || null, listing: of[F.orderLabel] || null, stage };
  const rooms = await fetchRooms(airtableToken, orderId);
  if (!rooms.length) return { ...context, ok: false, harvested: 0, reason: "this order has no room rows" };

  const session = await openSession();
  const items = [];
  const updates = [];

  for (const room of rooms) {
    const rf = room.fields || {};
    const label = rf[F.photoLabel] || room.id;
    const runId = String(rf[F.runId] || "").trim();
    const already = String(rf[plan.urlField] || "").trim();

    if (!runId) {
      // Already collected on an earlier pass, or this room was never started.
      // Both are reported plainly rather than guessed at.
      items.push({ label, state: already ? "already collected" : "never started", url: already || null });
      continue;
    }

    let run;
    try {
      // One snapshot poll, no waiting. A clip takes minutes and this function
      // has seconds; the caller comes back rather than holding the line open.
      run = await waitRun(runId, { session, timeoutSeconds: 0, maxWaitMs: 0 });
    } catch (e) {
      items.push({ label, state: "error", error: `could not read run ${runId}: ${String(e.message || e)}` });
      continue;
    }

    if (run.unreadable) {
      // The reply parsed as neither JSON nor TOON. This is the failure that
      // hid a finished render on HR-0006: it must be loud, not silent.
      console.error(`[harvest] could not read run ${runId}:`, String(run.raw).slice(0, 300));
      items.push({ label, state: "error", runId, error: "could not read the run status reply", raw: String(run.raw).slice(0, 200) });
      continue;
    }
    if (!run.done) {
      // `debug` carries the reply Magnific actually sent. Added 2026-09-15
      // because a run that WAS finished kept reporting as running and there was
      // no way to see what the function was being told — only what it concluded.
      // Costs nothing and is off unless asked for.
      const item = { label, state: "running", runId, status: run.status };
      if (debug) item._raw = JSON.stringify(run.raw).slice(0, 800);
      items.push(item);
      continue;
    }
    if (run.status && run.status !== "completed") {
      items.push({ label, state: "failed", runId, status: run.status });
      continue;
    }

    const ids = run.creationIdentifiers || [];
    if (!ids.length) {
      items.push({ label, state: "error", runId, error: "the run finished but produced no creation" });
      continue;
    }
    if (run.nodeRuns && run.nodeRuns.length > 1) {
      // Every run this system starts is `singular` — one node. More than one
      // means something ran downstream, which is exactly what the gates exist
      // to prevent. File the render, but say so loudly.
      console.error(`[harvest] run ${runId} covered ${run.nodeRuns.length} nodes; expected 1 (singular mode)`);
    }

    const creationId = ids[0];
    let url = null;
    try {
      url = creationUrl(await creationGet(creationId, { session }));
    } catch (e) {
      items.push({ label, state: "error", runId, creationId, error: `creations_get failed: ${String(e.message || e)}` });
      continue;
    }
    if (!url) {
      items.push({ label, state: "error", runId, creationId, error: "no URL on that creation" });
      continue;
    }

    // The URL field keeps the link; the attachment field makes Airtable copy
    // the BYTES. That copy is the one that still works next week — every
    // pikaso link dies about five days after it is fetched, and Gate 2 has to
    // be able to play the clip.
    const item = { label, state: "collected", runId, creationId, url };
    items.push(item);
    const fields = { [plan.urlField]: url, [plan.fileField]: [{ url }] };
    if (plan.rowStatus) fields[F.status] = plan.rowStatus;
    updates.push({
      id: room.id,
      item,                      // kept so a failed write marks the right room
      fields,
    });
  }

  // ---- write the rows ---------------------------------------------------
  let written = 0;
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    try {
      await atJson(encodeURIComponent(ORDER_PHOTOS), airtableToken, {
        method: "PATCH",
        // `item` is ours, not Airtable's — strip it before sending.
        //
        // ⚠ NO typecast. With typecast on, a Status value that is not one of
        // the field's existing options is silently CREATED as a new option
        // instead of rejected — so a typo quietly pollutes the vocabulary and
        // nothing ever tells you. Without it, a wrong value fails the write and
        // says so, which is what we want from anything that runs unattended.
        body: JSON.stringify({ records: batch.map(({ id, fields }) => ({ id, fields })) }),
      });
      written += batch.length;
    } catch (e) {
      // The render exists and is safe on the Space; only the filing failed.
      // Say which rooms, so a second call is known to be worth making.
      console.error("[harvest] could not write rows:", String(e.message || e));
      for (const r of batch) r.item.state = "collected but not saved";
    }
  }

  // ---- is the whole stage in? -------------------------------------------
  const have = rooms.filter((room) => {
    const saved = String(room.fields?.[plan.urlField] || "").trim();
    // An update that failed to save does NOT count as had — otherwise the gate
    // opens on a room whose render was never filed.
    return saved || updates.some((u) => u.id === room.id && u.item.state === "collected");
  }).length;

  const stillRunning = items.filter((i) => i.state === "running").length;
  const failed = items.filter((i) => ["failed", "error", "collected but not saved"].includes(i.state)).length;
  const complete = have === rooms.length && !stillRunning && !failed;

  const summary = {
    ...context,
    ok: true,
    rooms: rooms.length,
    harvested: written,
    have,
    stillRunning,
    failed,
    complete,
    items,
  };

  if (!complete) {
    // Deliberately does NOT move the order. A gate that opens on five of six
    // rooms sends a reviewer to look at an order that is not ready, and a film
    // missing a room is not a film.
    await appendLog(airtableToken, orderId, {
      level: failed ? "warn" : "info",
      event: `harvest:${stage}:partial`,
      detail: { rooms: rooms.length, have, stillRunning, failed, written },
    });
    return summary;
  }

  // ---- every room is in: open the gate ----------------------------------
  const fields = { [F.productionStatus]: plan.nextStatus };
  if (!of[plan.stopwatch]) fields[plan.stopwatch] = new Date().toISOString();

  await atJson(`${encodeURIComponent(ORDERS)}/${orderId}`, airtableToken, {
    method: "PATCH",
    body: JSON.stringify({ fields }),   // no typecast — see the note above
  });

  await appendLog(airtableToken, orderId, {
    level: "info",
    event: `harvest:${stage}:complete`,
    detail: {
      rooms: rooms.length,
      written,
      productionStatus: plan.nextStatus,
      note: `every ${plan.noun} is in; the order is now waiting on a human`,
    },
  });

  return { ...summary, movedTo: plan.nextStatus };
}

/**
 * Collect every order that is mid-render, in one call.
 *
 * This exists so that whatever ends up driving the clock — a scheduled task, a
 * cron somewhere else, the ops page, or Alvaro opening a URL — only ever needs
 * ONE address and no arguments. It asks Airtable which orders are at a
 * rendering stage rather than being told, so nothing has to keep a list.
 *
 * An order that fails is reported and skipped; one bad order never stops the
 * others being collected.
 */
export async function harvestAll(airtableToken, { base } = {}) {
  if (!airtableToken) throw new MagnificError(503, "AIRTABLE_TOKEN is not configured");

  const wanted = Object.values(STAGE).map((p) => p.from);
  const formula = `OR(${wanted.map((s) => `{${F.productionStatus}}="${s}"`).join(",")})`;

  const rows = [];
  let offset;
  do {
    const qs = new URLSearchParams({ pageSize: "100", filterByFormula: formula });
    if (offset) qs.set("offset", offset);
    const d = await atJson(`${encodeURIComponent(ORDERS)}?${qs}`, airtableToken);
    rows.push(...d.records);
    offset = d.offset;
  } while (offset);

  const orders = [];
  for (const rec of rows) {
    try {
      orders.push(await harvestOrder(rec.id, airtableToken, { base }));
    } catch (e) {
      console.error(`[harvest] ${rec.id} failed:`, String(e.message || e));
      orders.push({
        orderId: rec.id,
        job: rec.fields?.[F.jobNumber] || null,
        ok: false,
        error: String(e.message || e),
      });
    }
  }

  return {
    ok: true,
    sweep: true,
    rendering: rows.length,
    opened: orders.filter((o) => o.movedTo).length,
    stillRunning: orders.reduce((n, o) => n + (o.stillRunning || 0), 0),
    orders,
  };
}
