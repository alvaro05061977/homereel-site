// lib/gates.js — the two review gates decide what happens next.
//
// A reviewer approves the sixth keyframe and the clips should start. Every clip
// gets a verdict and assembly should start. Nobody should have to press a second
// button, and on HR-0005 that second button was a person (me) carrying work by
// hand from one stage to the next.
//
// This is the piece that removes that. Called by api/qc.js the moment a verdict
// is saved. It answers one question: did that verdict just complete a gate?
//
// WHAT IT DOES NOT DO. It never judges a render and it never overrides a
// verdict. A human decides every single one; this only notices when they have
// finished deciding. Gate 1 and Gate 2 stay human forever (build spec §6).
//
// FAILURE RULE, inherited from the canvas-sync path above it in api/qc.js: a
// problem here must NEVER fail the request. Losing a reviewer's verdict because
// the next stage could not be started would be far worse than a stage that
// starts late. Everything is caught, logged and reported back as data.

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const ORDERS = "Orders";
const ORDER_PHOTOS = "Order Photos";

const F = {
  order: "Order",
  photoLabel: "Photo",
  slot: "Slot Order",
  keyframeVerdict: "Keyframe Verdict",
  clipVerdict: "Clip Verdict",
  productionStatus: "Production Status",
  productionLog: "Production Log",
  jobNumber: "Job #",
};

// Gate 1 closes only on Approved. "Re-run" means a redraw is owed, and Pending
// means nobody has looked yet.
const KEYFRAME_DONE = new Set(["Approved"]);
// Gate 2 closes on Approved OR Trim. A trim is a decision, not a rejection —
// assembly applies Trim In/Out with video_cut, which is free.
const CLIP_DONE = new Set(["Approved", "Trim"]);

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
  if (!r.ok) throw new Error(`Airtable ${path} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
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
    console.error("[gates] production log append failed:", String(e));
  }
}

/**
 * Read where an order stands at one gate.
 * Returns { total, done, pending, rerun, complete, rooms:[{label, verdict}] }.
 * Exported because it is worth being able to ask this question on its own.
 */
export async function gateStatus(orderId, token, gate = "keyframe") {
  const rooms = await fetchRooms(token, orderId);
  const field = gate === "clip" ? F.clipVerdict : F.keyframeVerdict;
  const closing = gate === "clip" ? CLIP_DONE : KEYFRAME_DONE;

  const detail = rooms.map((r) => ({
    id: r.id,
    label: r.fields?.[F.photoLabel] || r.id,
    verdict: nameOf(r.fields?.[field]) || "Pending",
  }));

  const done = detail.filter((d) => closing.has(d.verdict)).length;
  const rerun = detail.filter((d) => d.verdict === "Re-run").length;

  return {
    gate,
    total: detail.length,
    done,
    rerun,
    pending: detail.length - done - rerun,
    // A gate is complete only when EVERY room has closed it. One room still
    // showing Re-run holds the whole order, which is correct: a film missing a
    // room is not a film.
    complete: detail.length > 0 && done === detail.length,
    rooms: detail,
  };
}

// Fire the next stage over HTTP: a separate endpoint runs in its own
// invocation with its own clock, so the reviewer's browser is never held open
// by a render that takes minutes. We wait a moment to be sure the request
// landed, then let go.
//
// ⚠ THE BASE URL COMES FROM THE INCOMING REQUEST, NOT FROM `VERCEL_URL`.
// Learned the hard way 2026-09-10: `VERCEL_URL` is the deployment-specific
// hostname, and this project has Vercel Authentication switched on for every
// `*.vercel.app` deployment URL. A function calling its own deployment URL is
// an unauthenticated visitor to a protected site, so it gets a 401 from Vercel
// before our code is ever reached — and the caller sees a doorbell that rang
// and a stage that never started. The host the request actually arrived on is
// the public one, so we ring that instead.
async function trigger(path, body, base) {
  const key = process.env.QC_KEY;
  if (!key) return { triggered: false, reason: "QC_KEY missing" };
  if (!base) return { triggered: false, reason: "no base URL — caller must pass the request's own host" };
  const controller = new AbortController();
  const stopWaiting = setTimeout(() => controller.abort(), 2500);
  try {
    const r = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, k: key }),
      signal: controller.signal,
    });
    return { triggered: true, status: r.status };
  } catch (e) {
    // An abort is the expected case for a long stage, not a failure.
    return { triggered: true, released: String(e.name || e) };
  } finally {
    clearTimeout(stopWaiting);
  }
}

/**
 * Called after a verdict is saved. Decides whether that verdict closed a gate,
 * and if so starts the next stage.
 *
 *   Gate 1 complete  → api/produce, stage "clips"
 *   Gate 2 complete  → api/assemble  (P1.6, not built yet — see below)
 *
 * Returns a plain object describing what it saw and did. Never throws.
 */
export async function afterVerdict(orderPhotoRecordId, gate, token, base) {
  const out = { gate, checked: false };
  try {
    const photo = await atJson(`${encodeURIComponent(ORDER_PHOTOS)}/${orderPhotoRecordId}`, token);
    const link = photo.fields?.[F.order];
    const orderId = Array.isArray(link) ? link[0]?.id || link[0] : link;
    if (!orderId) return { ...out, reason: "that room is not linked to an order" };

    const status = await gateStatus(orderId, token, gate);
    out.checked = true;
    out.orderId = orderId;
    out.status = { total: status.total, done: status.done, pending: status.pending, rerun: status.rerun };

    if (!status.complete) {
      // The normal case: a reviewer is part-way through. Say so and stop.
      return { ...out, complete: false, next: null };
    }

    if (gate === "keyframe") {
      // Every keyframe approved. Start the clips.
      //
      // api/produce re-checks everything itself — paid, not already running,
      // plates present, inside ORDER_BUDGET_CREDITS — so this is a doorbell,
      // not an authority. If a duplicate verdict save rings it twice, the
      // second ring is refused there as "already running".
      const fired = await trigger("/api/produce", { order: orderId, stage: "clips" }, base);
      await appendLog(token, orderId, {
        level: "info",
        event: "gate1:complete",
        detail: { rooms: status.total, next: "api/produce stage=clips", ...fired },
      });
      return { ...out, complete: true, next: "clips", ...fired };
    }

    // Gate 2 complete. Assembly is P1.6 and does not exist yet.
    //
    // ⚠ SEAM. When api/assemble lands, replace this block with the same
    // trigger() call used above. Everything needed is already true at this
    // point: every clip has a verdict, trims are recorded on their rows, and
    // assembly itself is FREE (Final Cut, mix and the deliverable combiner all
    // cost 0 credits — measured 2026-09-10). Until then this logs the fact so
    // the order is visibly waiting on a human rather than silently stuck.
    await appendLog(token, orderId, {
      level: "info",
      event: "gate2:complete",
      detail: {
        rooms: status.total,
        trims: status.rooms.filter((r) => r.verdict === "Trim").length,
        next: "api/assemble — NOT BUILT (build spec P1.6); assemble by hand for now",
      },
    });
    return { ...out, complete: true, next: "assemble", triggered: false, reason: "api/assemble is not built yet (P1.6)" };
  } catch (e) {
    // Swallowed on purpose. The verdict is already saved and that is what
    // matters; a missed doorbell can be rung again by calling api/produce.
    console.error("[gates] afterVerdict failed (verdict was still saved):", String(e));
    return { ...out, error: String(e.message || e) };
  }
}
