// Vercel serverless function: push an APPROVED keyframe onto the client's
// Magnific canvas, the moment the QC reviewer approves it.
//
// POST /api/canvas-sync   { recordId: "recXXXXXXXXXXXXXX" }
//        recordId = an ORDER PHOTOS row whose Keyframe Verdict just became Approved.
//        → 202 { ok: true, operationId } — the canvas edit is started, not awaited.
//
// WHY this exists: Airtable cannot write to a Magnific canvas, and Magnific
// Spaces do not exist on the REST API at all — they live only behind the
// OAuth-protected MCP server. That single fact is what made the July worker
// abandon Spaces. It was the wrong conclusion: the auth server (Keycloak,
// realm "mcp") advertises refresh_token + offline_access, so a server CAN hold
// a durable credential and act as the account owner. This function is that.
//
// WHAT IT DOES, per approved room (the operation was proven by hand first):
//   1. creation node "{Room} — APPROVED KEYFRAME" holding the approved still
//   2. drop the connection {Room} — COMPOSE .output → {Room} — ANIMATE .first-frame
//   3. connect APPROVED KEYFRAME .output → {Room} — ANIMATE .first-frame
// The COMPOSE node keeps its plate + character-sheet references, so the room
// stays re-runnable. Net effect: a clip can only ever animate from a still a
// human approved, because that still IS the animation's first frame.
//
// ENV VARS
//   AIRTABLE_TOKEN              (already set — shared with /api/order, /api/qc)
//   CANVAS_SYNC_KEY             shared secret; Airtable sends it as x-canvas-sync-key
//   MAGNIFIC_OAUTH_CLIENT_ID    OAuth client id registered against realm "mcp"
//   MAGNIFIC_OAUTH_CLIENT_SECRET   omit for a public (PKCE) client
//   MAGNIFIC_REFRESH_TOKEN      long-lived token from ONE interactive sign-in
//                               with scope "openid offline_access"
//
// ⚠ The refresh token is a live credential for the Magnific account. It is set
// in the Vercel dashboard by a human and read only from the environment here.
//
// ⚠ Keycloak realms usually expire refresh tokens after an idle period (often
// 30 days). If that happens every call fails with invalid_grant and the canvas
// silently stops updating — which is why that case is loud in the logs and
// returns 503 rather than being swallowed.

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const ORDER_PHOTOS = "Order Photos";
const ORDERS = "Orders";

const MCP_URL = "https://mcp.magnific.com";
const TOKEN_URL =
  "https://auth.magnific.com/realms/mcp/protocol/openid-connect/token";

const F = {
  roomType: "Room Type",
  keyframeUrl: "Keyframe URL",
  keyframeVerdict: "Keyframe Verdict",
  order: "Order",
  spaceId: "Magnific Space ID",
  address: "Listing / Order",
};

// Wizard's Room Type labels -> the room names used on the master canvas.
// Same mapping the canvas recipe uses; the wizard and the canvas disagree on
// three labels and this is the only place that translation lives.
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

// --- Airtable ---------------------------------------------------------

async function at(path, token) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new HttpError(502, `Airtable ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

// --- Magnific auth ----------------------------------------------------

// Exchanges the stored refresh token for a short-lived access token.
// Keycloak may ROTATE the refresh token on each use. If it does, the new one
// is only valid for this process and is lost on the next cold start — which
// would break the integration within a day. So this deliberately does NOT rely
// on rotation: if the realm is configured to rotate, the setup needs a token
// store instead, and the log line below is what tells you that is happening.
async function accessToken() {
  const clientId = process.env.MAGNIFIC_OAUTH_CLIENT_ID;
  const refreshToken = process.env.MAGNIFIC_REFRESH_TOKEN;
  if (!clientId || !refreshToken) {
    throw new HttpError(503, "Magnific OAuth is not configured (MAGNIFIC_OAUTH_CLIENT_ID / MAGNIFIC_REFRESH_TOKEN)");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (process.env.MAGNIFIC_OAUTH_CLIENT_SECRET) {
    body.set("client_secret", process.env.MAGNIFIC_OAUTH_CLIENT_SECRET);
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    // invalid_grant = the refresh token expired or was revoked. Loud on purpose:
    // the failure mode of a silent credential is a canvas that quietly stops
    // updating and nobody notices for a month.
    console.error("[canvas-sync] MAGNIFIC TOKEN REFRESH FAILED", res.status, json.error, json.error_description);
    throw new HttpError(503, `Magnific token refresh failed (${json.error || res.status}) — the stored refresh token may have expired; re-authorize it.`);
  }
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    console.warn("[canvas-sync] Magnific ROTATED the refresh token. The stored one will stop working — this integration needs a token store, not an env var.");
  }
  return json.access_token;
}

// --- Magnific MCP (streamable HTTP, JSON-RPC) -------------------------

// Responses may come back as JSON or as a one-event SSE stream depending on
// the client's Accept header; this handles both rather than assuming.
function parseMcp(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
  }
  throw new Error(`Unparseable MCP response: ${trimmed.slice(0, 200)}`);
}

class McpSession {
  constructor(token) {
    this.token = token;
    this.sessionId = null;
    this.id = 0;
  }

  async rpc(method, params, { notify = false } = {}) {
    const payload = notify
      ? { jsonrpc: "2.0", method, params }
      : { jsonrpc: "2.0", id: ++this.id, method, params };

    const res = await fetch(MCP_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify(payload),
    });

    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;

    if (notify) return null;

    const text = await res.text();
    if (!res.ok) throw new HttpError(502, `MCP ${method} -> ${res.status}: ${text.slice(0, 300)}`);

    const json = parseMcp(text);
    if (json.error) throw new HttpError(502, `MCP ${method} error: ${JSON.stringify(json.error).slice(0, 300)}`);
    return json.result;
  }

  async open() {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "homereel-canvas-sync", version: "1.0" },
    });
    await this.rpc("notifications/initialized", {}, { notify: true });
  }

  // MCP tool results arrive as content blocks; the useful payload is either
  // structuredContent or JSON inside the first text block.
  async callTool(name, args) {
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (result?.structuredContent) return result.structuredContent;
    const text = result?.content?.find((c) => c.type === "text")?.text;
    if (!text) return result;
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
}

// --- the edit ---------------------------------------------------------

// Written as an explicit, node-name-addressed instruction because the canvas
// is a duplicate of the master and therefore always uses these exact names.
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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const expected = process.env.CANVAS_SYNC_KEY;
    if (!expected) throw new HttpError(503, "CANVAS_SYNC_KEY is not set — refusing to run unauthenticated");
    if (req.headers["x-canvas-sync-key"] !== expected) throw new HttpError(401, "Bad or missing x-canvas-sync-key");

    const airtableToken = process.env.AIRTABLE_TOKEN;
    if (!airtableToken) throw new HttpError(503, "AIRTABLE_TOKEN is not set");

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
    const recordId = body.recordId;
    if (!/^rec[A-Za-z0-9]{14}$/.test(String(recordId || ""))) {
      throw new HttpError(400, "recordId (an Order Photos record id) is required");
    }

    // 1. The room row.
    const photo = await at(`${encodeURIComponent(ORDER_PHOTOS)}/${recordId}`, airtableToken);
    const fields = photo.fields || {};

    const verdict = fields[F.keyframeVerdict];
    const verdictName = typeof verdict === "object" ? verdict?.name : verdict;
    if (verdictName !== "Approved") {
      // Not an error — Airtable may fire on any edit. Nothing unapproved is
      // ever allowed onto the canvas, so this is the guard that enforces it.
      return res.status(200).json({ ok: true, skipped: `verdict is "${verdictName}", not Approved` });
    }

    const keyframeUrl = fields[F.keyframeUrl];
    if (!keyframeUrl) throw new HttpError(422, "That room has no Keyframe URL");

    const room = canvasRoomName(fields[F.roomType]);
    if (!room) throw new HttpError(422, `Room Type "${JSON.stringify(fields[F.roomType])}" does not map to a canvas room`);

    // 2. The order's canvas.
    const orderLink = fields[F.order];
    const orderId = Array.isArray(orderLink) ? orderLink[0]?.id || orderLink[0] : orderLink;
    if (!orderId) throw new HttpError(422, "That room is not linked to an order");

    const order = await at(`${encodeURIComponent(ORDERS)}/${orderId}`, airtableToken);
    const spaceId = order.fields?.[F.spaceId];
    if (!spaceId) {
      throw new HttpError(422, `Order "${order.fields?.[F.address] || orderId}" has no Magnific Space ID — no canvas was built for it`);
    }

    // 3. Magnific.
    const mcp = new McpSession(await accessToken());
    await mcp.open();

    // Keyframe URLs are Cloudinary (permanent). Ingesting the URL gives us a
    // creation identifier, which is what a canvas node holds.
    const upload = await mcp.callTool("creations_upload_image", { url: keyframeUrl });
    const creationIdentifier = upload?.identifier;
    if (!creationIdentifier) throw new HttpError(502, `Upload returned no identifier: ${JSON.stringify(upload).slice(0, 200)}`);

    // spaces_edit is ASYNC — it returns an operationId and the work continues
    // server-side for 20-40s. Deliberately NOT awaited to completion: a
    // serverless handler that blocks on it is one platform timeout away from
    // looking broken. Airtable gets a fast 202; verification is a separate concern.
    const edit = await mcp.callTool("spaces_edit", {
      spaceId,
      query: editQuery(room, creationIdentifier),
    });

    console.log("[canvas-sync] queued", { room, spaceId, creationIdentifier, operationId: edit?.operationId });

    return res.status(202).json({
      ok: true,
      room,
      spaceId,
      creationIdentifier,
      operationId: edit?.operationId || null,
    });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error("[canvas-sync] FAILED", err);
    return res.status(status).json({ error: err.message });
  }
}
