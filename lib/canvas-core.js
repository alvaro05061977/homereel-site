// lib/canvas-core.js — put an APPROVED keyframe onto the client's Magnific canvas.
//
// Lives outside /api on purpose: Vercel routes every file under /api as an
// endpoint, and this is a library, not a route. Two callers use it:
//   - api/qc.js       → the moment a reviewer approves a room in the dashboard
//   - api/canvas-sync.js → the same thing over HTTP, for manual re-syncs
//
// WHY the QC endpoint is the trigger rather than Airtable: the approval already
// passes through our own server on its way to Airtable, so we learn about it
// first-hand and instantly. (Airtable's "Run script" action, the other way to
// do this, is a paid-plan feature — and would have been a second moving part
// and a second secret for no benefit.)
//
// ⚠ KNOWN GAP: a verdict set directly in the Airtable Gate page does NOT pass
// through here and will not reach the canvas. The QC dashboard is the intended
// instrument; if the Airtable pages start getting used for verdicts, add a
// reconciliation pass rather than trusting this path alone.
//
// Env vars:
//   MAGNIFIC_OAUTH_CLIENT_ID      public OAuth client on Keycloak realm "mcp"
//   MAGNIFIC_REFRESH_TOKEN        from one interactive device-flow sign-in
//   MAGNIFIC_OAUTH_CLIENT_SECRET  omit for a public client
//   AIRTABLE_TOKEN                passed in by the caller

import { MagnificError as CanvasSyncError, openSession, uploadFromUrl } from "./magnific.js";

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const ORDER_PHOTOS = "Order Photos";
const ORDERS = "Orders";

const F = {
  roomType: "Room Type",
  keyframeUrl: "Keyframe URL",
  keyframeAttachment: "Keyframe",
  keyframeVerdict: "Keyframe Verdict",
  order: "Order",
  spaceId: "Magnific Space ID",
  address: "Listing / Order",
};

// Wizard Room Type labels -> master-canvas room names. The wizard and the
// canvas disagree on four labels; this is the only place that lives.
const ROOM_ALIASES = new Map([
  ["front exterior", "Front Exterior"],
  ["kitchen", "Kitchen"],
  ["foyer", "Foyer"],
  ["foyer / entry", "Foyer"],
  ["living room", "Living Room"],
  ["dining", "Dining"],
  ["primary bedroom", "Bedroom"],
  ["bedroom", "Bedroom"],
  ["game room", "Game Room"],
  ["media room", "Media Room"],
  ["breakfast nook", "Nook"],
  ["nook", "Nook"],
  ["patio", "Patio"],
  ["pool", "Pool"],
  ["backyard / lawn", "Backyard"],
  ["backyard", "Backyard"],
  ["something else", "Other Room"],
  ["other room", "Other Room"],
  ["other", "Other Room"],
]);

function canvasRoomName(roomType) {
  const raw = typeof roomType === "object" ? roomType?.name : roomType;
  return ROOM_ALIASES.get(String(raw || "").trim().toLowerCase()) || null;
}

// One error class, two names. lib/magnific.js owns it; api/canvas-sync.js still
// imports CanvasSyncError from here, and because this is the SAME class, every
// existing `instanceof` keeps matching.
export { CanvasSyncError };

async function airtableGet(path, token) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new CanvasSyncError(502, `Airtable ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

// Magnific auth and the MCP transport used to live here. They moved to
// lib/magnific.js on 2026-09-09 (build spec P1.1) so there is exactly one copy
// of the OAuth recipe. Nothing about the recipe changed.

// The canvas is always a duplicate of the master, so node names are known.
function editQuery(room, creationIdentifier) {
  return [
    `Place an approved keyframe on this canvas and make it the animation source for the ${room} room. Do not run or generate anything. Do not change any prompt.`,
    ``,
    `1. Create a creation node named "${room} — APPROVED KEYFRAME" holding creationIdentifier ${creationIdentifier}. Position it between the "${room} — COMPOSE" node and the "${room} — ANIMATE" node. If a node with that name already exists, update it to this creationIdentifier instead of creating a second one.`,
    `2. Remove any existing connection into the "${room} — ANIMATE" node's first-frame input.`,
    `3. Connect the "${room} — APPROVED KEYFRAME" node's output into the "${room} — ANIMATE" node's first-frame input.`,
    ``,
    `Leave "${room} — COMPOSE" in place with all of its existing reference connections intact so the room can still be re-run. Leave every other room, the character sheets, the combiner, music, mix, overlay and end-card nodes untouched.`,
  ].join("\n");
}

// --- the one public function -----------------------------------------

// recordId = an Order Photos row. Re-reads the verdict from Airtable rather
// than trusting the caller, so nothing unapproved can ever reach a canvas.
// Returns {synced:false, reason} when it deliberately does nothing.
export async function syncApprovedKeyframe(recordId, airtableToken) {
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(recordId || ""))) {
    throw new CanvasSyncError(400, "recordId (an Order Photos record id) is required");
  }

  const photo = await airtableGet(`${encodeURIComponent(ORDER_PHOTOS)}/${recordId}`, airtableToken);
  const fields = photo.fields || {};

  const verdict = fields[F.keyframeVerdict];
  const verdictName = typeof verdict === "object" ? verdict?.name : verdict;
  if (verdictName !== "Approved") {
    return { synced: false, reason: `verdict is "${verdictName}", not Approved` };
  }

  // Prefer the Airtable ATTACHMENT copy of the keyframe. "Keyframe URL" holds
  // the raw generator link (a signed pikaso URL that expires ~24h after the
  // render - verified on HR-0005, every stored Keyframe URL carried a token
  // that had already expired). Airtable re-signs attachment URLs on every API
  // read, so this one is fresh for as long as the request lasts. Fall back to
  // the text field only for old rows whose attachment never got populated.
  const att = fields[F.keyframeAttachment];
  const keyframeUrl = (Array.isArray(att) && att[0] && att[0].url) || fields[F.keyframeUrl];
  if (!keyframeUrl) throw new CanvasSyncError(422, "That room has no Keyframe attachment or Keyframe URL");

  const room = canvasRoomName(fields[F.roomType]);
  if (!room) throw new CanvasSyncError(422, `Room Type ${JSON.stringify(fields[F.roomType])} does not map to a canvas room`);

  const orderLink = fields[F.order];
  const orderId = Array.isArray(orderLink) ? orderLink[0]?.id || orderLink[0] : orderLink;
  if (!orderId) throw new CanvasSyncError(422, "That room is not linked to an order");

  const order = await airtableGet(`${encodeURIComponent(ORDERS)}/${orderId}`, airtableToken);
  const spaceId = order.fields?.[F.spaceId];
  if (!spaceId) {
    throw new CanvasSyncError(422, `Order "${order.fields?.[F.address] || orderId}" has no Magnific Space ID — no canvas was built for it`);
  }

  // One session, reused for both calls below.
  const mcp = await openSession();

  // Ingesting the keyframe yields the creation identifier a canvas node holds.
  // Magnific copies the bytes, so the source URL only has to live for this call.
  // uploadFromUrl throws a CanvasSyncError(502) carrying the raw payload if the
  // upload comes back without an identifier.
  const creationIdentifier = await uploadFromUrl(keyframeUrl, { session: mcp });

  // spaces_edit is ASYNC — it returns an operationId and keeps working for
  // 20-40s server-side. Deliberately not awaited to completion: a serverless
  // handler that blocks on it is one platform timeout from looking broken.
  const edit = await mcp.callTool("spaces_edit", {
    spaceId,
    query: editQuery(room, creationIdentifier),
  });

  console.log("[canvas] queued", { room, spaceId, creationIdentifier, operationId: edit?.operationId });
  return {
    synced: true,
    room,
    spaceId,
    creationIdentifier,
    operationId: edit?.operationId || null,
  };
}
