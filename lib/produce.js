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
// HOW IT RUNS. Not as a Flow. A Flow is one button that runs a whole board end
// to end, and this pipeline must stop twice — once for a human to judge the
// keyframes, once to watch the clips. So step 5 runs ONE NODE PER ROOM on the
// order's own Magnific Space and stops there. Each room's run identifier is
// written to its own row; api/harvest collects the outputs.
//
// The order must already have a Magnific Space ID. Building that board per
// order is the piece that is still by hand (docs/operations/Canvas_Manifest.md);
// with no board there is nothing to run and this refuses, having spent nothing.

import { openSession, MagnificError } from "./magnific.js";
import { readNodes, findNode, simulateNode, runNode } from "./space.js";
import { canvasRoomName } from "./canvas-core.js";
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
  runId: "Run ID",
};

// What a render costs, per the operating rules (CLAUDE.md §8) and the Seedance
// 2.5 price confirmed on 2026-09-08. These are ESTIMATES used for the first,
// cheap budget check. Before anything runs, simulate_spaces gives Magnific's
// own price per node and the budget is checked again against that — and it is
// that figure, for the nodes actually started, that is added to Credits Spent.
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
  const estimate = rooms.length * perRoom;
  // This is the CHEAP check — a table lookup, no network, run before anything
  // is read from Magnific. The real number comes from simulate_spaces inside
  // runStage, which checks this budget again before it starts a single node.
  const estimateSource = "table of per-node costs";

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
  const run = await runStage({ stage, order: of, rooms, orderId, airtableToken, budget, alreadySpent });
  if (!run.ran) {
    return { ...context, ok: true, ran: false, reason: run.reason, budget: budgetLine, plates };
  }

  const fields = {
    [F.productionStatus]: stage === "clips" ? "Rendering Clips" : "Rendering Keyframes",
  };
  if (run.runId) fields[F.flowRunId] = run.runId;
  if (run.spaceId) fields[F.spaceId] = run.spaceId;
  if (!of[F.claimedAt]) fields[F.claimedAt] = new Date().toISOString();

  // Charge the order NOW, at the price Magnific quoted, not later when the
  // renders are collected. Magnific bills when a run starts, and if this
  // function — or harvest — never gets to finish, an uncharged order would let
  // the next call spend the same budget over again. Harvest reconciles it to
  // the real figure; until then the guard has a number to work with.
  if (run.credits) fields[F.creditsSpent] = alreadySpent + run.credits;

  await atJson(`${encodeURIComponent(ORDERS)}/${orderId}`, airtableToken, {
    method: "PATCH",
    body: JSON.stringify({ fields, typecast: true }),
  });

  // The run ids are the only thread back to the outputs. They go in the log as
  // well as on the rows, so a failed row write is recoverable by hand.
  await appendLog(airtableToken, orderId, {
    level: run.incomplete || run.runIdsRecorded === false ? "warn" : "info",
    event: "produce:started",
    detail: {
      stage,
      spaceId: run.spaceId || null,
      credits: run.credits ?? null,
      priced: run.priced ?? null,
      runs: (run.runs || []).map((r) => ({ room: r.roomName, node: r.nodeId, runId: r.runId, credits: r.credits })),
      runIdsRecorded: run.runIdsRecorded !== false,
      incomplete: run.incomplete || null,
      ...budgetLine,
    },
  });

  return {
    ...context,
    ok: true,
    ran: true,
    runId: run.runId || null,
    spaceId: run.spaceId || null,
    runs: (run.runs || []).map((r) => ({ room: r.roomName, node: r.nodeName, runId: r.runId, credits: r.credits })),
    credits: run.credits ?? null,
    incomplete: run.incomplete || null,
    budget: budgetLine,
    plates,
  };
}

/**
 * Run one stage of renders on the order's own Magnific Space — one node per
 * room, and nothing downstream of it.
 *
 * WHY ONE NODE AT A TIME, when Magnific can run a whole board or a whole Flow
 * with one call: the two QC gates ARE the product. A human looks at every
 * keyframe and watches every clip. `downstream` or `connected` mode would carry
 * straight past Gate 1 into 3,950-credit clips made from frames nobody
 * approved. So this starts exactly the N nodes the stage needs and stops.
 *
 * It does not wait for them. A clip takes minutes and this runs inside a
 * serverless function with seconds to live. Each room's run identifier is
 * written to its own row (Order Photos → Run ID); collecting the outputs is
 * api/harvest's job.
 *
 * Nothing is spent until every room has been resolved to a real node AND
 * Magnific has priced every one of them. A missing node, an unknown room name,
 * or a node that prices wrong stops the whole stage before the first credit.
 */
const NODE_SUFFIX = { keyframes: "COMPOSE", clips: "ANIMATE" };
const NODE_TYPE = { keyframes: "image-generator", clips: "video-generator" };

// A per-node sanity bound, separate from the order budget. A COMPOSE node
// prices at ~100 and an ANIMATE at ~3,950. Anything far above that means the
// node is not the node we think it is — wrong model, wrong mode, or wired to
// pull work in behind it. Refusing costs nothing; guessing costs a clip.
const PER_NODE_CEILING = { keyframes: 250, clips: 4500 };

async function runStage({ stage, order, rooms, orderId, airtableToken, budget, alreadySpent }) {
  const spaceId = String(order[F.spaceId] || "").trim();
  if (!spaceId) {
    return {
      ran: false,
      reason:
        "This order has no Magnific Space ID, so there is no board to run. The per-client canvas is built " +
        "from docs/operations/Canvas_Manifest.md; until that is automated it is built in the app and its id " +
        "pasted into the order. Nothing was spent and no status changed.",
    };
  }

  const suffix = NODE_SUFFIX[stage];
  const nodeType = NODE_TYPE[stage];
  const session = await openSession();

  // Read the board once. If Magnific has changed its reply format, readNodes
  // throws rather than hand back a node id it is not sure of.
  const nodes = await readNodes(spaceId, { session });

  // ---- resolve every room to exactly one node, BEFORE running anything ----
  const targets = [];
  const problems = [];
  for (const room of rooms) {
    const label = room.fields?.[F.photoLabel] || room.id;
    const roomName = canvasRoomName(room.fields?.[F.roomType]);
    if (!roomName) {
      problems.push(`${label}: room type "${nameOf(room.fields?.[F.roomType]) || "(empty)"}" has no canvas name`);
      continue;
    }
    const nodeName = `${roomName} — ${suffix}`;
    try {
      const node = findNode(nodes, nodeName, nodeType);
      targets.push({ recordId: room.id, label, roomName, nodeName, nodeId: node.id, slot: room.fields?.[F.slot] ?? null });
    } catch (e) {
      problems.push(`${label}: ${e.message}`);
    }
  }
  if (problems.length) {
    return {
      ran: false,
      reason: `The board does not match the order, so nothing was run: ${problems.join("; ")}`,
      spaceId,
    };
  }

  // ---- let Magnific price it. Read-only; never charges. ------------------
  let priced = 0;
  for (const t of targets) {
    const sim = await simulateNode(spaceId, t.nodeId, { session });
    t.credits = sim.credits;
    priced += sim.credits;
    if (sim.credits > PER_NODE_CEILING[stage]) {
      return {
        ran: false,
        spaceId,
        reason:
          `"${t.nodeName}" prices at ${sim.credits} credits; a ${stage === "clips" ? "clip" : "keyframe"} ` +
          `should cost about ${stage === "clips" ? CREDITS.clip : CREDITS.keyframe}. Refusing the whole stage — ` +
          "that price usually means the node is not what we think it is, or something upstream of it would run too.",
      };
    }
  }

  // The budget was already checked against the cost table. Now we have
  // Magnific's own number, so check it again — this is the one that counts.
  if (alreadySpent + priced > budget) {
    return {
      ran: false,
      spaceId,
      priced,
      reason:
        `Magnific prices this stage at ${priced} credits. With ${alreadySpent} already spent that is ` +
        `${alreadySpent + priced}, over the ${budget}-credit budget for this order. Nothing was started.`,
    };
  }

  // ---- run ---------------------------------------------------------------
  const runs = [];
  let failure = null;
  for (const t of targets) {
    try {
      const runId = await runNode(spaceId, t.nodeId, { session });
      runs.push({ ...t, runId });
    } catch (e) {
      failure = `${t.nodeName}: ${e.message || e}`;
      break;
    }
  }

  // Whatever started is already costing money, so the run ids get written
  // before anything else is allowed to go wrong. Losing them means the outputs
  // are stranded on the board with nothing pointing at them.
  const recorded = await writeRunIds(airtableToken, runs);

  if (!runs.length) {
    return { ran: false, spaceId, reason: `Nothing started. ${failure}` };
  }

  return {
    ran: true,
    spaceId,
    runId: null,          // per-node runs; there is no single run id for the order
    runs,
    // What was actually started, which is what Magnific bills. If one node
    // failed to start it was not charged, so it is not counted here.
    credits: runs.reduce((n, r) => n + (r.credits || 0), 0),
    priced,               // what the whole stage would have cost
    runIdsRecorded: recorded,
    incomplete: failure,  // some rooms started, then one failed — the caller must say so
  };
}

// Write each room's run id onto its own row. Airtable takes 10 records per
// PATCH. A failure here is logged, not thrown: the runs are already paid for
// and the caller still has the ids in its return value and in the log line.
async function writeRunIds(token, runs) {
  if (!runs.length) return true;
  let ok = true;
  for (let i = 0; i < runs.length; i += 10) {
    const records = runs.slice(i, i + 10).map((r) => ({ id: r.recordId, fields: { [F.runId]: r.runId } }));
    try {
      await atJson(encodeURIComponent(ORDER_PHOTOS), token, {
        method: "PATCH",
        body: JSON.stringify({ records }),
      });
    } catch (e) {
      ok = false;
      console.error("[produce] COULD NOT RECORD RUN IDS — outputs may be stranded:", String(e.message || e), records.map((r) => r.id).join(","));
    }
  }
  return ok;
}
