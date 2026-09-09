// lib/produce.js — start an order's renders, or refuse to and say why.
//
// This is the only place in the system that can cause Magnific to spend money,
// so most of it is refusals. In order:
//
//   1. the order must be Paid
//   2. it must not already be running (a double webhook must not double-spend)
//   3. every image must be in Magnific (calls ingestPlates; free, idempotent)
//   4. the estimated cost plus what is already spent must fit ORDER_BUDGET_CREDITS
//   5. only then does it run anything
//
// Step 4 is the circuit-breaker. Auto top-up is switched on for the Magnific
// account, which means a runaway loop cannot run out of money — it just keeps
// buying more. This cap is the only thing standing between a bug and a bill.
//
// ⚠ THE RUN ITSELF IS NOT WIRED YET. It needs a published Flow, which is Phase 0
// P0.1 and belongs to Alvaro in the Magnific app. Until MAGNIFIC_FLOW_ID is set
// this returns `ran: false` with a reason, having changed nothing and spent
// nothing. Everything above it is real and testable today. See `runStage` below
// for exactly what to fill in.

import { openSession, callTool, flowRun, MagnificError } from "./magnific.js";
import { ingestPlates } from "./plates.js";

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const ORDERS = "Orders";
const ORDER_PHOTOS = "Order Photos";

const F = {
  orderLabel: "Listing / Order",
  jobNumber: "Job #",
  paymentStatus: "Payment Status",
  productionStatus: "Production Status",
  productionLog: "Production Log",
  creditsSpent: "Credits Spent",
  spaceId: "Magnific Space ID",
  flowRunId: "Flow Run ID",
  claimedAt: "Claimed At",
  headshotId: "Headshot Creation ID",
  logoId: "Logo Creation ID",
  // Order Photos
  order: "Order",
  photoLabel: "Photo",
  slot: "Slot Order",
  roomType: "Room Type",
  creationId: "Magnific Creation ID",
};

// What a render costs, per the operating rules (CLAUDE.md §8) and the Seedance
// 2.5 price confirmed on 2026-09-08. These are ESTIMATES used to decide whether
// to start; the real number comes back from the run and is what gets added to
// Credits Spent.
//
// Note the keyframe figure. The rules say ~100; the August worker log recorded
// 75 per keyframe. The higher number is used on purpose — a budget guard that
// under-estimates is not a guard.
export const CREDITS = {
  keyframe: 100,
  clip: 3950,
};

const DEFAULT_BUDGET = 45000;

// Which stage a status means we are already past. Starting keyframes when the
// order is at QC Clips would re-render work a human has already approved.
const IN_FLIGHT = new Set([
  "Rendering Keyframes",
  "Rendering Clips",
  "Assembling",
  "Delivering",
]);
const PAST_KEYFRAMES = new Set([
  "QC Keyframes",
  "Rendering Clips",
  "QC Clips",
  "Assembling",
  "Awaiting Approval",
  "Delivering",
  "Delivered",
]);

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

const nameOf = (cell) => (cell && typeof cell === "object" ? cell.name : cell) || "";

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
    console.error("[produce] production log append failed:", String(e));
  }
}

// A refusal is a RESULT, not an exception. The caller wants to show the reason,
// and a thrown error would lose the detail that makes it actionable.
function refuse(reason, detail = {}) {
  return { ok: false, ran: false, refused: reason, ...detail };
}

/**
 * Start a stage of production for one order.
 *
 * @param stage   "keyframes" (Gate 1) or "clips" (Gate 2)
 * @param dryRun  run every check and report the estimate, then stop before
 *                anything is spent or any status changes. This is the mode to
 *                use when you just want to know what it would cost.
 */
export async function startOrder(orderId, airtableToken, { stage = "keyframes", dryRun = false, force = false } = {}) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(orderId || ""))) {
    throw new MagnificError(400, "orderId (an Orders record id) is required");
  }
  if (stage !== "keyframes" && stage !== "clips") {
    throw new MagnificError(400, 'stage must be "keyframes" or "clips"');
  }
  if (!airtableToken) throw new MagnificError(503, "AIRTABLE_TOKEN is not configured");

  const order = await atJson(`${encodeURIComponent(ORDERS)}/${orderId}`, airtableToken);
  const of = order.fields || {};
  const context = {
    orderId,
    job: of[F.jobNumber] || null,
    listing: of[F.orderLabel] || null,
    stage,
    dryRun,
  };

  // ---- 1. paid ----------------------------------------------------------
  const payment = nameOf(of[F.paymentStatus]);
  if (payment !== "Paid") {
    return { ...context, ...refuse("not paid", { paymentStatus: payment || "(empty)" }) };
  }

  // ---- 2. not already running ------------------------------------------
  const status = nameOf(of[F.productionStatus]);
  if (!force && IN_FLIGHT.has(status)) {
    return { ...context, ...refuse("already running", { productionStatus: status }) };
  }
  if (!force && stage === "keyframes" && PAST_KEYFRAMES.has(status)) {
    // Re-running keyframes here would throw away approved work. A single room
    // that genuinely needs redoing goes through the Gate 1 Re-run verdict, not
    // through this endpoint.
    return { ...context, ...refuse("already past the keyframe stage", { productionStatus: status }) };
  }

  const rooms = await fetchRooms(airtableToken, orderId);
  if (!rooms.length) {
    return { ...context, ...refuse("this order has no room rows") };
  }

  // ---- 3. every image inside Magnific ----------------------------------
  // Free and idempotent, so it runs on every start. This is the safety net for
  // the one untested link in the chain: if the Stripe webhook's call to
  // /api/plates was ever lost, it is repaired here, before a credit is spent.
  const plates = await ingestPlates(orderId, airtableToken);
  const missing = rooms.length - rooms.filter((r) => String(r.fields?.[F.creationId] || "").trim()).length;
  const platesNow = plates.items.filter((i) => i.creationId).length;
  if (!plates.ok || (missing > 0 && platesNow < rooms.length)) {
    return {
      ...context,
      ...refuse("some images are not in Magnific yet", { plates }),
    };
  }

  // ---- 4. budget --------------------------------------------------------
  const budget = Number(process.env.ORDER_BUDGET_CREDITS || DEFAULT_BUDGET);
  const alreadySpent = Number(of[F.creditsSpent] || 0);
  const perRoom = stage === "clips" ? CREDITS.clip : CREDITS.keyframe;
  let estimate = rooms.length * perRoom;
  let estimateSource = "table of per-node costs";

  const flowId = process.env.MAGNIFIC_FLOW_ID;
  if (flowId) {
    // Magnific's own number beats ours whenever a Flow exists to ask about.
    // Read-only; never charges.
    try {
      const sim = await callTool("simulate_flows", { identifier: flowId });
      const credits = sim?.credits ?? sim?.totalCredits ?? sim?.cost;
      if (typeof credits === "number") {
        estimate = credits;
        estimateSource = "simulate_flows";
      }
    } catch (e) {
      console.error("[produce] simulate_flows failed, falling back to the cost table:", String(e.message || e));
    }
  }

  const projected = alreadySpent + estimate;
  const budgetLine = { estimate, estimateSource, alreadySpent, projected, budget, rooms: rooms.length };

  if (projected > budget) {
    await appendLog(airtableToken, orderId, {
      level: "error",
      event: "budget:refused",
      detail: budgetLine,
    });
    return { ...context, ...refuse("over the credit budget", { budget: budgetLine }) };
  }

  // Written BEFORE the run, always. The build spec's rule: never spend without
  // first logging what the spend was expected to be.
  await appendLog(airtableToken, orderId, {
    level: "info",
    event: dryRun ? "budget:simulated" : "budget:approved",
    detail: budgetLine,
  });

  if (dryRun) {
    return { ...context, ok: true, ran: false, dryRun: true, budget: budgetLine, plates };
  }

  // ---- 5. run -----------------------------------------------------------
  const run = await runStage({ stage, flowId, order: of, rooms, orderId });
  if (!run.ran) {
    return { ...context, ok: true, ran: false, reason: run.reason, budget: budgetLine, plates };
  }

  const fields = {
    [F.productionStatus]: stage === "clips" ? "Rendering Clips" : "Rendering Keyframes",
  };
  if (run.runId) fields[F.flowRunId] = run.runId;
  if (run.spaceId) fields[F.spaceId] = run.spaceId;
  if (!of[F.claimedAt]) fields[F.claimedAt] = new Date().toISOString();

  await atJson(`${encodeURIComponent(ORDERS)}/${orderId}`, airtableToken, {
    method: "PATCH",
    body: JSON.stringify({ fields, typecast: true }),
  });

  await appendLog(airtableToken, orderId, {
    level: "info",
    event: "produce:started",
    detail: { stage, runId: run.runId || null, spaceId: run.spaceId || null, ...budgetLine },
  });

  return { ...context, ok: true, ran: true, runId: run.runId || null, spaceId: run.spaceId || null, budget: budgetLine, plates };
}

/**
 * ⚠ THE SEAM. This is the only part of production that Phase 0 blocks.
 *
 * To finish it, three things are needed and none of them can be guessed:
 *
 *   1. MAGNIFIC_FLOW_ID — the published Flow (Phase 0 P0.1, Alvaro, in the app).
 *   2. docs/operations/Flow_Spec.md — the exact input IDs from `flows_get`.
 *      `flows_run` takes { inputId: value }, and an input ID invented from the
 *      node's display name will not match.
 *   3. The answer to P0.3: does one run stop at Gate 1, or does it go all the
 *      way to the film? If it cannot stop, this becomes two Flows and `stage`
 *      selects between them.
 *
 * `buildInputs` below is where the order's data meets those IDs. It is written
 * out as far as it honestly can be — the values are all in hand — and left
 * unmapped, because mapping them to invented keys would be documentation of
 * behaviour the code does not have.
 */
async function runStage({ stage, flowId, order, rooms, orderId }) {
  if (!flowId) {
    return {
      ran: false,
      reason:
        "MAGNIFIC_FLOW_ID is not set. Phase 0 P0.1 (publish the template as a Flow) has not been done, " +
        "so there is nothing to run. Every check above passed; nothing was spent and no status changed.",
    };
  }

  const inputs = buildInputs({ order, rooms });
  if (!inputs) {
    return {
      ran: false,
      reason:
        "A Flow is configured but docs/operations/Flow_Spec.md has not been recorded, so the input IDs are unknown. " +
        "Run flows_get on the Flow, write the spec, then map it in buildInputs().",
    };
  }

  const session = await openSession();
  const runId = await flowRun(flowId, inputs, { session });
  return { ran: true, runId, spaceId: null };
}

// Everything the Flow will need, gathered and named. The KEYS are the open
// question — they must be the input IDs `flows_get` reports, not these labels.
export function orderInputValues({ order, rooms }) {
  return {
    photos: rooms.map((r) => ({
      slot: r.fields?.[F.slot] ?? null,
      room: nameOf(r.fields?.[F.roomType]),
      label: r.fields?.[F.photoLabel] || "",
      creationId: r.fields?.[F.creationId] || null,
    })),
    headshotCreationId: order[F.headshotId] || null,
    logoCreationId: order[F.logoId] || null,
    address: order[F.orderLabel] || "",
    agentName: order["Agent Name"] || "",
    brokerage: order["Brokerage"] || "",
    phone: order["Phone"] || "",
    website: order["Handle / Website"] || "",
    family: (order["Family"] || []).map((f) => f.name || f).join(", "),
    soundtrack: (order["Soundtrack"] || []).map((s) => s.name || s).join(", "),
  };
}

function buildInputs({ order, rooms }) {
  const values = orderInputValues({ order, rooms });
  const map = process.env.MAGNIFIC_FLOW_INPUT_MAP;
  if (!map) return null;
  // The map is JSON from Flow_Spec.md: { "<flow input id>": "<value key>" }.
  // Keeping it in an env var means the Flow can be re-published with different
  // input IDs without a code change — which will happen at least once while
  // Phase 0 settles the shape.
  try {
    const spec = JSON.parse(map);
    const out = {};
    for (const [inputId, key] of Object.entries(spec)) {
      out[inputId] = key === "photos" ? values.photos.map((p) => p.creationId) : values[key];
    }
    return out;
  } catch (e) {
    console.error("[produce] MAGNIFIC_FLOW_INPUT_MAP is not valid JSON:", String(e));
    return null;
  }
}
