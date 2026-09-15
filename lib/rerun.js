// lib/rerun.js — a "Re-run" verdict sends ONE room back through its own node.
//
// The third and last piece of the loop. produce starts a stage, harvest collects
// it, and this is what happens when a human looks at a render and says no.
//
// It re-runs exactly ONE node: that room's COMPOSE at Gate 1, that room's
// ANIMATE at Gate 2. Nothing else on the board moves, and no other room is
// touched. This is the whole economic argument for a strict Gate 1 — a keyframe
// redraw is 100 credits, and the clip it prevents is 3,950.
//
// WHAT IT DELIBERATELY THROWS AWAY. The rejected render's URL and attachment are
// cleared the moment the re-run starts. That looks wasteful and is not: leaving
// them there means a reviewer who opens the QC viewer before the new render
// lands is shown the OLD, REJECTED picture with a blank verdict beside it — and
// may well approve it. The row goes blank and says "Re-running" instead.
//
// It also puts the order back to its rendering status, because that is what the
// harvest sweep looks for. A re-run nobody collects is a credit spent for
// nothing.
//
// ⚠ NO typecast on any write here. Every value sent is one Airtable already
// knows: "Pending" is a real Keyframe/Clip Verdict option, and the two
// rendering statuses are real Production Status options. With typecast on, a
// typo in any of them would be silently created as a NEW option rather than
// rejected. Off, a wrong value fails loudly — which is what unattended code
// should do.

import { openSession, MagnificError } from "./magnific.js";
import { readNodes, findNode, simulateNode, runNode } from "./space.js";
import { canvasRoomName } from "./canvas-core.js";

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const ORDERS = "Orders";
const ORDER_PHOTOS = "Order Photos";

const F = {
  // Orders
  jobNumber: "Job #",
  orderLabel: "Listing / Order",
  paymentStatus: "Payment Status",
  productionStatus: "Production Status",
  productionLog: "Production Log",
  creditsSpent: "Credits Spent",
  spaceId: "Magnific Space ID",
  // Order Photos
  order: "Order",
  photoLabel: "Photo",
  roomType: "Room Type",
  runId: "Run ID",
  status: "Status",
  keyframeVerdict: "Keyframe Verdict",
  keyframeUrl: "Keyframe URL",
  keyframeFile: "Keyframe",
  clipVerdict: "Clip Verdict",
  clipUrl: "Clip URL",
  clipFile: "Clip",
};

// Everything that differs between the two gates, in one place.
const GATE = {
  keyframe: {
    verdictField: F.keyframeVerdict,
    urlField: F.keyframeUrl,
    fileField: F.keyframeFile,
    suffix: "COMPOSE",
    nodeType: "image-generator",
    ceiling: 250,
    expected: 100,
    backTo: "Rendering Keyframes",
    noun: "keyframe",
  },
  clip: {
    verdictField: F.clipVerdict,
    urlField: F.clipUrl,
    fileField: F.clipFile,
    suffix: "ANIMATE",
    nodeType: "video-generator",
    ceiling: 4500,
    expected: 3950,
    backTo: "Rendering Clips",
    noun: "clip",
  },
};

const DEFAULT_BUDGET = 45000;
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
    console.error("[rerun] production log append failed:", String(e));
  }
}

// A refusal is a RESULT, not an exception — same rule as lib/produce.js. The
// caller wants to show the reason, and throwing would lose the detail that
// makes it actionable.
const refuse = (reason, detail = {}) => ({ ok: false, ran: false, refused: reason, ...detail });

/**
 * Re-run one room's node after a Re-run verdict.
 *
 * @param recordId  the Order Photos row
 * @param gate      "keyframe" or "clip"
 * @param opts.force  skip the "the verdict must actually say Re-run" check.
 *                    For a manual retry after a failed render, not for routine use.
 */
export async function rerunRoom(recordId, gate, airtableToken, { force = false } = {}) {
  const plan = GATE[gate];
  if (!plan) throw new MagnificError(400, 'gate must be "keyframe" or "clip"');
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(recordId || ""))) {
    throw new MagnificError(400, "recordId (an Order Photos record id) is required");
  }
  if (!airtableToken) throw new MagnificError(503, "AIRTABLE_TOKEN is not configured");

  const room = await atJson(`${encodeURIComponent(ORDER_PHOTOS)}/${recordId}`, airtableToken);
  const rf = room.fields || {};
  const label = rf[F.photoLabel] || recordId;
  const context = { recordId, label, gate };

  const verdict = nameOf(rf[plan.verdictField]);
  if (!force && verdict !== "Re-run") {
    return { ...context, ...refuse(`that room's ${plan.noun} verdict is "${verdict || "Pending"}", not "Re-run"`) };
  }

  const link = rf[F.order];
  const orderId = Array.isArray(link) ? link[0]?.id || link[0] : link;
  if (!orderId) return { ...context, ...refuse("that room is not linked to an order") };

  const order = await atJson(`${encodeURIComponent(ORDERS)}/${orderId}`, airtableToken);
  const of = order.fields || {};
  context.orderId = orderId;
  context.job = of[F.jobNumber] || null;

  if (nameOf(of[F.paymentStatus]) !== "Paid") {
    return { ...context, ...refuse("that order is not paid") };
  }

  const spaceId = String(of[F.spaceId] || "").trim();
  if (!spaceId) return { ...context, ...refuse("that order has no Magnific Space ID, so there is no board to run") };

  const roomName = canvasRoomName(rf[F.roomType]);
  if (!roomName) {
    return { ...context, ...refuse(`room type "${nameOf(rf[F.roomType]) || "(empty)"}" has no canvas name`) };
  }
  const nodeName = `${roomName} — ${plan.suffix}`;

  // ---- resolve, price, check the budget — before anything is spent --------
  const session = await openSession();
  const nodes = await readNodes(spaceId, { session });

  let node;
  try {
    node = findNode(nodes, nodeName, plan.nodeType);
  } catch (e) {
    return { ...context, ...refuse(String(e.message || e), { nodeName }) };
  }

  const sim = await simulateNode(spaceId, node.id, { session });
  if (sim.credits > plan.ceiling) {
    return {
      ...context,
      ...refuse(
        `"${nodeName}" prices at ${sim.credits} credits; a ${plan.noun} should cost about ${plan.expected}. ` +
        "Refusing — that price usually means the node is not what we think it is.",
        { nodeName, credits: sim.credits }
      ),
    };
  }

  const budget = Number(process.env.ORDER_BUDGET_CREDITS || DEFAULT_BUDGET);
  const alreadySpent = Number(of[F.creditsSpent] || 0);
  if (alreadySpent + sim.credits > budget) {
    await appendLog(airtableToken, orderId, {
      level: "error",
      event: "rerun:budget-refused",
      detail: { label, gate, credits: sim.credits, alreadySpent, budget },
    });
    return {
      ...context,
      ...refuse(
        `re-running this ${plan.noun} costs ${sim.credits} credits; with ${alreadySpent} already spent that is ` +
        `${alreadySpent + sim.credits}, over the ${budget}-credit budget for this order.`,
        { credits: sim.credits, alreadySpent, budget }
      ),
    };
  }

  // ---- run ---------------------------------------------------------------
  const runId = await runNode(spaceId, node.id, { session });

  // The rejected render goes NOW, so nobody can approve it while the new one
  // renders. Verdict back to blank (Pending) so the gate is no longer complete.
  await atJson(`${encodeURIComponent(ORDER_PHOTOS)}/${recordId}`, airtableToken, {
    method: "PATCH",
    body: JSON.stringify({
      fields: {
        [F.runId]: runId,
        [plan.verdictField]: "Pending",   // a real option on both verdict fields
        [plan.urlField]: null,
        [plan.fileField]: [],
        // Status is deliberately left alone: its only options are
        // uploaded / composed / approved / ingested and none of them means
        // "being redrawn". The cleared render and the Pending verdict already
        // say everything a reviewer needs.
      },
    }),
  });

  // Back to the rendering status, or the harvest sweep will never look at this
  // order again. Credits charged at start, same rule as produce: Magnific bills
  // when the run begins.
  await atJson(`${encodeURIComponent(ORDERS)}/${orderId}`, airtableToken, {
    method: "PATCH",
    body: JSON.stringify({
      fields: {
        [F.productionStatus]: plan.backTo,
        [F.creditsSpent]: alreadySpent + sim.credits,
      },
    }),
  });

  await appendLog(airtableToken, orderId, {
    level: "info",
    event: `rerun:${gate}`,
    detail: { label, node: node.id, nodeName, runId, credits: sim.credits, backTo: plan.backTo },
  });

  return {
    ...context,
    ok: true,
    ran: true,
    nodeName,
    nodeId: node.id,
    runId,
    credits: sim.credits,
    spaceId,
    backTo: plan.backTo,
  };
}
