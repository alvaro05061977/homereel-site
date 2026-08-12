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

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const ORDER_PHOTOS = "Order Photos";
const ORDERS = "Orders";

const MCP_URL = "https://mcp.magnific.com";
const TOKEN_URL = "https://auth.magnific.com/realms/mcp/protocol/openid-connect/token";

const F = {
  roomType: "Room Type",
  keyframeUrl: "Keyframe URL",
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

export class CanvasSyncError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function airtableGet(path, token) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new CanvasSyncError(502, `Airtable ${path} -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

// --- Magnific auth ----------------------------------------------------

async function accessToken() {
  const clientId = process.env.MAGNIFIC_OAUTH_CLIENT_ID;
  const refreshToken = process.env.MAGNIFIC_REFRESH_TOKEN;
  if (!clientId || !refreshToken) {
    throw new CanvasSyncError(503, "Magnific OAuth is not configured (MAGNIFIC_OAUTH_CLIENT_ID / MAGNIFIC_REFRESH_TOKEN)");
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
    // Loud on purpose. A silently-expired credential means a canvas that stops
    // updating and nobody notices for a month.
    console.error("[canvas] MAGNIFIC TOKEN REFRESH FAILED", res.status, json.error, json.error_description);
    throw new CanvasSyncError(503, `Magnific token refresh failed (${json.error || res.status}) — the refresh token may have expired; re-authorize it.`);
  }
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    console.warn("[canvas] Magnific ROTATED the refresh token. The stored one will stop working — this needs a token store, not an env var.");
  }
  return json.access_token;
}

// --- Magnific MCP (streamable HTTP JSON-RPC) --------------------------

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
    if (!res.ok) throw new CanvasSyncError(502, `MCP ${method} -> ${res.status}: ${text.slice(0, 300)}`);

    const json = parseMcp(text);
    if (json.error) throw new CanvasSyncError(502, `MCP ${method} error: ${JSON.stringify(json.error).slice(0, 300)}`);
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

  const keyframeUrl = fields[F.keyframeUrl];
  if (!keyframeUrl) throw new CanvasSyncError(422, "That room has no Keyframe URL");

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

  const mcp = new McpSession(await accessToken());
  await mcp.open();

  // Keyframe URLs are permanent Cloudinary copies; ingesting one yields the
  // creation identifier a canvas node holds.
  const upload = await mcp.callTool("creations_upload_image", { url: keyframeUrl });
  const creationIdentifier = upload?.identifier;
  if (!creationIdentifier) {
    throw new CanvasSyncError(502, `Upload returned no identifier: ${JSON.stringify(upload).slice(0, 200)}`);
  }

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
