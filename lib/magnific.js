// lib/magnific.js — the one Magnific client. Everything that talks to Magnific
// from Vercel goes through this file.
//
// It exists because the auth recipe below took four failed attempts to find
// (see project memory: magnific-machine-auth), and a second copy of it is a
// second thing to get wrong. lib/canvas-core.js used to own it; canvas-core now
// imports from here, so there is exactly one implementation.
//
// Env vars:
//   MAGNIFIC_OAUTH_CLIENT_ID      public OAuth client on Keycloak realm "mcp"
//   MAGNIFIC_REFRESH_TOKEN        from one interactive device-flow sign-in
//   MAGNIFIC_OAUTH_CLIENT_SECRET  omit for a public client
//
// Nothing here spends credits on its own. The generation tools (spaces_run,
// video_generate, flows_run) do; call simulate first and log the number, per
// the build spec's budget rule.

export const MCP_URL = "https://mcp.magnific.com";
const TOKEN_URL = "https://auth.magnific.com/realms/mcp/protocol/openid-connect/token";

// Carries an HTTP status so a route handler can pass it straight through.
// canvas-core re-exports this under its old name CanvasSyncError, so anything
// doing `instanceof CanvasSyncError` still matches — it is the same class.
export class MagnificError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --- auth -------------------------------------------------------------

export async function accessToken() {
  const clientId = process.env.MAGNIFIC_OAUTH_CLIENT_ID;
  const refreshToken = process.env.MAGNIFIC_REFRESH_TOKEN;
  if (!clientId || !refreshToken) {
    throw new MagnificError(503, "Magnific OAuth is not configured (MAGNIFIC_OAUTH_CLIENT_ID / MAGNIFIC_REFRESH_TOKEN)");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
    // The EXACT scope set mcp.magnific.com demands (learned the hard way,
    // 2026-08-12). Without mcp:custom-audience the auth server mints a token
    // whose audience is NOT the MCP resource, and every call comes back as a
    // bare 401 {"message":"Unauthenticated."} that looks like a bad credential.
    // Dropping profile/email leaves the app unable to resolve which Magnific
    // user the token belongs to — same 401, valid token. offline_access is ours,
    // for the refresh token. Read it from the horse's mouth if this breaks: an
    // unauthenticated POST to the MCP endpoint returns WWW-Authenticate with the
    // scope string. The scope is fixed when the refresh token is minted, so it
    // must also have been present on the original device-flow sign-in.
    scope: "openid profile email offline_access mcp:custom-audience",
    // RFC 8707 resource indicator, required by the MCP authorization spec.
    // With the scope above, this is what stamps aud=https://mcp.magnific.com on
    // the token. Verified 2026-08-13: without BOTH, aud comes back null.
    resource: MCP_URL,
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
    // Loud on purpose. A silently-expired credential means production stops and
    // nobody notices for a month.
    console.error("[magnific] TOKEN REFRESH FAILED", res.status, json.error, json.error_description);
    throw new MagnificError(503, `Magnific token refresh failed (${json.error || res.status}) — the refresh token may have expired; re-authorize it.`);
  }
  // A CHANGED refresh token does not by itself mean the old one is dead:
  // Keycloak returns a fresh one on every refresh but only invalidates the
  // previous one when "Revoke Refresh Token" is enabled on the realm. Verified
  // by refreshing twice with the same token.
  if (json.refresh_token && json.refresh_token !== refreshToken) {
    console.log("[magnific] note: a new refresh token was issued. Harmless unless the realm also revokes the old one — if calls start failing with invalid_grant, this needs a token store rather than an env var.");
  }

  // Claims only, never the token itself. This is the line that diagnoses a 401.
  try {
    const claims = JSON.parse(Buffer.from(json.access_token.split(".")[1], "base64").toString("utf8"));
    console.log("[magnific] token aud:", JSON.stringify(claims.aud), "scope:", claims.scope);
    if (!claims.aud) {
      console.error("[magnific] TOKEN HAS NO AUDIENCE — mcp.magnific.com will reject it with a bare 401. The OAuth client must be REGISTERED with the mcp:custom-audience scope (requesting it is not enough; Keycloak silently drops a scope the client is not allowed), and both the sign-in and this refresh must send resource=" + MCP_URL);
    }
  } catch {
    /* opaque or unexpected token shape — not worth failing over */
  }

  return json.access_token;
}

// --- MCP transport (streamable HTTP JSON-RPC) -------------------------

function parseMcp(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  for (const line of trimmed.split("\n")) {
    if (line.startsWith("data:")) return JSON.parse(line.slice(5).trim());
  }
  throw new MagnificError(502, `Unparseable MCP response: ${trimmed.slice(0, 200)}`);
}

export class McpSession {
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
    if (!res.ok) throw new MagnificError(502, `MCP ${method} -> ${res.status}: ${text.slice(0, 300)}`);

    const json = parseMcp(text);
    if (json.error) throw new MagnificError(502, `MCP ${method} error: ${JSON.stringify(json.error).slice(0, 300)}`);
    return json.result;
  }

  async open() {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "homereel", version: "1.0" },
    });
    await this.rpc("notifications/initialized", {}, { notify: true });
    return this;
  }

  // Magnific answers some tools with JSON and some with TOON text (flows_get,
  // spaces_state). A TOON answer arrives here as { text: "..." } rather than
  // being mangled into an object — read it as text, do not JSON.parse it.
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

// A fresh, opened session. One token refresh per call, so a function making
// several Magnific calls should open ONE session and pass it down via the
// { session } option every helper below accepts.
export async function openSession() {
  return new McpSession(await accessToken()).open();
}

async function withSession(session, fn) {
  if (session) return fn(session);
  return fn(await openSession());
}

// One-shot escape hatch for anything without a helper here. Opens a session,
// makes the call, drops it.
export async function callTool(name, args, { session } = {}) {
  return withSession(session, (mcp) => mcp.callTool(name, args));
}

// --- helpers ----------------------------------------------------------

function identifierOf(res, what) {
  const id =
    res?.identifier ||
    res?.creation?.identifier ||
    (Array.isArray(res?.creations) && res.creations[0]?.identifier) ||
    (Array.isArray(res) && res[0]?.identifier);
  if (!id) throw new MagnificError(502, `${what} returned no creation identifier: ${JSON.stringify(res).slice(0, 300)}`);
  return id;
}

// Ingest a publicly-fetchable image URL and get back the creation identifier a
// canvas node holds. Magnific copies the bytes, so the source URL only has to
// survive this call — which is why an Airtable attachment URL (re-signed on
// every API read) is a fine source and a stored pikaso link is not.
export async function uploadFromUrl(url, { session, folderReference } = {}) {
  if (!url) throw new MagnificError(400, "uploadFromUrl needs a url");
  return withSession(session, async (mcp) => {
    const args = { url };
    if (folderReference) args.folderReference = folderReference;
    return identifierOf(await mcp.callTool("creations_upload_image", args), "creations_upload_image");
  });
}

// ⚠ UNVERIFIED SHAPE. The three-step upload (request → PUT → finalize) has not
// yet been run end to end from Vercel; the field names below are read off the
// tool descriptions, not off a live response. First real caller should log the
// raw creations_request_upload result and tighten this. Until then it throws a
// legible error instead of failing silently.
function pickUploadSlot(res) {
  const cand = (Array.isArray(res?.uploads) && res.uploads[0]) || (Array.isArray(res) && res[0]) || res || {};
  const url = cand.uploadUrl || cand.url || cand.presignedUrl || cand.signedUrl;
  const path = cand.path || cand.key || cand.temporaryPath;
  if (!url || !path) {
    throw new MagnificError(502, `creations_request_upload returned no usable {url, path}: ${JSON.stringify(res).slice(0, 400)}`);
  }
  return { url, path };
}

// For bytes we hold rather than a URL Magnific can reach — the rendered end
// card, above all. Limits enforced server-side: SVG 10MB, raster 25MB,
// audio 50MB, video 200MB.
export async function uploadBytes(bytes, mimeType, { session, folderReference, visible } = {}) {
  if (!bytes) throw new MagnificError(400, "uploadBytes needs bytes");
  if (!mimeType) throw new MagnificError(400, "uploadBytes needs a mimeType");
  return withSession(session, async (mcp) => {
    const slot = pickUploadSlot(await mcp.callTool("creations_request_upload", { mimeType }));

    const put = await fetch(slot.url, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: bytes,
    });
    if (!put.ok) {
      throw new MagnificError(502, `Presigned PUT -> ${put.status}: ${(await put.text().catch(() => "")).slice(0, 200)}`);
    }

    const args = { path: slot.path };
    if (folderReference) args.folderReference = folderReference;
    if (visible === false) args.visible = false;
    return identifierOf(await mcp.callTool("creations_finalize_upload", args), "creations_finalize_upload");
  });
}

// --- Flows ------------------------------------------------------------

// inputs is { inputId: value }, and the input IDs come from flows_get — which
// is why docs/operations/Flow_Spec.md exists. Do not guess an input ID.
export async function flowRun(flowId, inputs, { session } = {}) {
  if (!flowId) throw new MagnificError(400, "flowRun needs a flow identifier");
  return withSession(session, async (mcp) => {
    const res = await mcp.callTool("flows_run", { identifier: flowId, inputs: inputs || {} });
    const runId = res?.workflowRunIdentifier || res?.identifier;
    if (!runId) throw new MagnificError(502, `flows_run returned no workflowRunIdentifier: ${JSON.stringify(res).slice(0, 300)}`);
    return runId;
  });
}

function pollAfter(res) {
  const v = res?.poll_after_seconds ?? res?.pollAfterSeconds ?? res?.result?.poll_after_seconds;
  return typeof v === "number" ? v : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Long-polls until the run is terminal or the budget runs out. Returns
// { done, result } — done:false is NOT an error, it means "still rendering,
// come back later", which is the normal answer inside a serverless handler.
// A clip render takes minutes; only a cron or a second call should chase it.
export async function flowWait(workflowRunIdentifier, { session, timeoutSeconds = 25, maxWaitMs = 50_000 } = {}) {
  if (!workflowRunIdentifier) throw new MagnificError(400, "flowWait needs a workflowRunIdentifier");
  return withSession(session, async (mcp) => {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const res = await mcp.callTool("flows_wait", { workflowRunIdentifier, timeoutSeconds });
      const again = pollAfter(res);
      if (again === null) return { done: true, result: res };
      if (Date.now() + again * 1000 >= deadline) return { done: false, result: res };
      await sleep(again * 1000);
    }
  });
}

export async function flowSpec(flowId, { session } = {}) {
  return callTool("flows_get", { identifier: flowId }, { session });
}

// --- Spaces and creations ---------------------------------------------

// Read-only board context. scope "all" walks every page and is expensive; the
// default is the current page. Returns TOON text as { text }.
export async function spaceState(spaceId, { session, scope, pageId } = {}) {
  if (!spaceId) throw new MagnificError(400, "spaceState needs a spaceId");
  const args = { spaceId };
  if (scope) args.scope = scope;
  if (pageId) args.pageId = pageId;
  return callTool("spaces_state", args, { session });
}

// Metadata plus FRESHLY SIGNED urls (url full-res, previewUrl ~1024px,
// thumbnailUrl ~400px). This is the fix for the expired-link problem: store the
// creation identifier, resolve the URL at the moment you need it. Never store
// the signed URL.
export async function creationGet(creationIdentifier, { session } = {}) {
  if (!creationIdentifier) throw new MagnificError(400, "creationGet needs a creationIdentifier");
  return callTool("creations_get", { creationIdentifier }, { session });
}

// Plan and credits. Cheap, spends nothing — the health check for this file.
export async function accountBalance({ session } = {}) {
  return callTool("account_balance", {}, { session });
}
