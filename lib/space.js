// lib/space.js — drive one node on a client's Magnific Space, from code.
//
// This is the piece that replaces "Claude runs the node". The pipeline needs
// exactly three verbs and no more:
//
//   readNodes(spaceId)          what is on this board, by name
//   runNode(spaceId, nodeId)    run ONE node, nothing else
//   waitRun(runId)              what came out
//
// WHY ONE NODE AT A TIME. The two QC gates are the product. A human judges
// every keyframe and every clip, and a stage must STOP so they can. So the code
// never says "run the board"; it says "run these six", waits, and stops. A
// re-run is the same verb with one node. `spaces_run` mode is always
// `singular` here — `downstream` and `connected` would run past a gate, and
// `connected` re-runs work that has already been approved.
//
// COST. Every run is priced first with `simulate_spaces`, which is read-only
// and never charges. Nothing spends without the number being known and logged.

import { callTool, openSession, MagnificError } from "./magnific.js";

// ---- reading the board ----------------------------------------------------
//
// ⚠ `spaces_state` answers in TOON, a layout meant for reading, not parsing.
// We need one thing from it: node id → node name. So this parses ONLY the
// `nodes[...]` block and ignores everything else.
//
// The block looks like:
//
//   nodes[6]{id,type,name,selected,x,y,width,height,pageId,...}:
//     44e92ee8-…,music-generator,Client Music Bed — drop track here,false,12654.93,…
//
// The header names the columns, so the shape is known. The only hazard is a
// node NAME containing a comma. Splitting left-to-right would then eat the
// following column. So: take `id` and `type` from the left, take the fixed
// number of trailing columns from the RIGHT, and treat whatever is left in the
// middle as the name. A comma in a name is then harmless.
//
// If Magnific changes this format, this function returns nothing and every
// caller refuses to run. That is deliberate: a wrong node id means running the
// wrong node, and a clip is 3,950 credits. Refusing is cheap; guessing is not.
// TOON quotes any value it needs to — a name with a comma, a colon, or one that
// would otherwise look like a number ("DELIVERABLE 16:9 — Mix + End Card"). The
// quotes are syntax, not part of the name, so they come off before anyone tries
// to match on it.
function unquote(v) {
  const s = String(v ?? "").trim();
  return s.length > 1 && s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

export function parseNodes(toon) {
  const text = typeof toon === "string" ? toon : toon?.text || "";
  const lines = text.split("\n");

  const headerIdx = lines.findIndex((l) => /^\s*nodes\[\d+\]\{[^}]*\}\s*:\s*$/.test(l));
  if (headerIdx === -1) return [];

  const cols = lines[headerIdx].replace(/^[^{]*\{/, "").replace(/\}.*$/, "").split(",").map((c) => c.trim());
  const iId = cols.indexOf("id");
  const iType = cols.indexOf("type");
  const iName = cols.indexOf("name");
  // This parser assumes the three columns it needs come first, in this order.
  // Every sample seen does. If that ever changes, refuse rather than mis-map.
  if (iId !== 0 || iType !== 1 || iName !== 2) return [];

  const trailing = cols.length - 3; // columns after `name`
  const out = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!/^\s+\S/.test(raw)) break;        // the block ends at the first non-indented line
    const parts = raw.trim().split(",");
    if (parts.length < cols.length) continue;

    const id = unquote(parts[0]);
    const type = unquote(parts[1]);
    const name = unquote(parts.slice(2, parts.length - trailing).join(","));
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;   // not a node row

    out.push({ id, type, name });
  }
  return out;
}

export async function readNodes(spaceId, { session } = {}) {
  if (!spaceId) throw new MagnificError(400, "readNodes needs a spaceId");
  const state = await callTool("spaces_state", { spaceId }, { session });
  const nodes = parseNodes(state);
  if (!nodes.length) {
    throw new MagnificError(502, "Could not read the nodes on that Space. The board may be empty, or Magnific changed its reply format — refusing rather than guessing a node id.");
  }
  return nodes;
}

// Find exactly one node by name. Refuses on none and on more than one, because
// two nodes called "Kitchen — ANIMATE" means somebody duplicated a room and the
// right answer is a human looking, not a coin toss.
export function findNode(nodes, name, type) {
  const wanted = String(name || "").trim().toLowerCase();
  const matches = nodes.filter(
    (n) => n.name.trim().toLowerCase() === wanted && (!type || n.type === type)
  );
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    throw new MagnificError(422, `No node named "${name}"${type ? ` of type ${type}` : ""} on that Space`);
  }
  throw new MagnificError(422, `${matches.length} nodes are named "${name}" on that Space — a human needs to look before anything runs`);
}

// ---- running --------------------------------------------------------------

export async function simulateNode(spaceId, nodeId, { session, mode = "singular" } = {}) {
  const sim = await callTool("simulate_spaces", { spaceId, startNodeId: nodeId, mode }, { session });
  const credits = sim?.credits;
  if (typeof credits !== "number") {
    throw new MagnificError(502, `simulate_spaces gave no credit figure: ${JSON.stringify(sim).slice(0, 200)}`);
  }
  return { credits, certainty: sim?.certainty || null, isUnlimited: Boolean(sim?.isUnlimited) };
}

export async function runNode(spaceId, nodeId, { session, mode = "singular" } = {}) {
  if (!spaceId || !nodeId) throw new MagnificError(400, "runNode needs a spaceId and a nodeId");
  const res = await callTool("spaces_run", { spaceId, startNodeId: nodeId, mode }, { session });
  const runId = res?.workflowRunIdentifier;
  if (!runId) {
    throw new MagnificError(502, `spaces_run returned no run identifier: ${JSON.stringify(res).slice(0, 200)}`);
  }
  return runId;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- reading a run's status ----------------------------------------------
//
// ⚠ `spaces_run_status` does NOT always answer in JSON. Through one MCP client
// it returns a clean object; from inside a Vercel function the same call came
// back as TOON text, which lib/magnific.js hands over untouched as { text }.
// Reading that with `res.status` gives undefined, and the old code then called
// it "running" — so a FINISHED render looked like a slow one, for ever, and
// the gate never opened. Caught live on HR-0006, 2026-09-15.
//
// The lesson is the project's own standing rule, again: a capability statement
// is scoped to the surface it came from. "It returns clean JSON" was true of
// the surface it was tested on and false of the one that mattered.
//
// So: read BOTH shapes, and when neither yields an answer say `unknown`
// instead of guessing. Never report "still rendering" unless the reply
// actually said so.
export function parseRunStatus(res) {
  if (res && (res.allTerminal !== undefined || res.status !== undefined)) {
    return {
      known: true,
      allTerminal: res.allTerminal === true,
      status: res.status || null,
      creationIdentifiers: res.creationIdentifiers || [],
      nodeRuns: res.nodeRuns || [],
    };
  }

  const text = typeof res === "string" ? res : res?.text;
  if (typeof text !== "string" || !text.trim()) return { known: false };

  const status = text.match(/(?:^|\s)"?status"?\s*[:=]\s*"?([A-Za-z_-]+)"?/)?.[1] || null;
  const allTerminal = /"?allTerminal"?\s*[:=]\s*"?true"?/.test(text);
  // Creation ids appear as a JSON array, a TOON list, or bare on their own
  // lines under creationIdentifiers. Take them wherever they are, de-duplicated
  // and in order.
  const ids = [];
  const block = text.match(/creationIdentifiers[^\n]*[:=]([^\n]*(?:\n\s+[^\n]*)*)/);
  if (block) for (const m of block[1].matchAll(/[A-Za-z0-9_-]{6,}/g)) if (!ids.includes(m[0])) ids.push(m[0]);

  if (!status && !allTerminal) return { known: false, raw: text.slice(0, 300) };
  return { known: true, allTerminal, status, creationIdentifiers: ids, nodeRuns: [] };
}

// Poll a run. Returns { done, creationIdentifiers, nodeRuns, raw }.
//
// `done:false` is NOT a failure — it means "still rendering, ask again later",
// which is the normal answer inside a serverless function. A clip takes minutes;
// only a cron or a later call should chase it.
//
// Shape observed live 2026-09-15:
//   {"allTerminal":true,"status":"completed","creationIdentifiers":["s7RIeYKl8e"],
//    "nodeRuns":[{"nodeId":"3ec62b16-…","creationIdentifiers":["s7RIeYKl8e"]}]}
export async function waitRun(workflowRunIdentifier, { session, timeoutSeconds = 25, maxWaitMs = 50_000 } = {}) {
  if (!workflowRunIdentifier) throw new MagnificError(400, "waitRun needs a run identifier");
  const deadline = Date.now() + maxWaitMs;

  for (;;) {
    const res = await callTool("spaces_run_status", { workflowRunIdentifier, timeoutSeconds }, { session });
    const p = parseRunStatus(res);

    // Neither shape parsed. Do NOT call this "running" — that is what made a
    // finished render invisible. Say so, and let the caller report it.
    if (!p.known) {
      return {
        done: false,
        unreadable: true,
        status: null,
        creationIdentifiers: [],
        nodeRuns: [],
        raw: p.raw || res,
      };
    }

    const terminal = p.allTerminal || ["completed", "failed", "cancelled"].includes(p.status);

    if (terminal) {
      return {
        done: true,
        status: p.status,
        creationIdentifiers: p.creationIdentifiers,
        nodeRuns: p.nodeRuns,
        raw: res,
      };
    }

    const again = typeof res?.poll_after_seconds === "number" ? res.poll_after_seconds : 5;
    if (Date.now() + again * 1000 >= deadline) {
      return { done: false, status: p.status || "running", creationIdentifiers: [], nodeRuns: [], raw: res };
    }
    await sleep(again * 1000);
  }
}

// ---- the one thing callers actually want ----------------------------------
//
// Price it, refuse if it costs more than expected, run it, wait. Returns the
// creation the node produced.
//
// `maxCredits` is a per-node sanity bound, separate from the order budget in
// lib/produce.js. It catches the case where a node is not what we think it is:
// an assembly node should cost 0, a keyframe 100, a clip 3,950. If the price
// comes back wrong, the wiring is wrong, and running it would be a waste.
export async function runOneNode(spaceId, nodeId, { session, maxCredits = null, label = nodeId } = {}) {
  const mcp = session || (await openSession());
  const sim = await simulateNode(spaceId, nodeId, { session: mcp });

  if (maxCredits !== null && sim.credits > maxCredits) {
    throw new MagnificError(
      409,
      `"${label}" was expected to cost at most ${maxCredits} credits but prices at ${sim.credits}. Refusing — that usually means the node is not what we think it is.`
    );
  }

  const runId = await runNode(spaceId, nodeId, { session: mcp });
  const result = await waitRun(runId, { session: mcp });

  return {
    label,
    nodeId,
    runId,
    credits: sim.credits,
    done: result.done,
    status: result.status,
    creationId: result.creationIdentifiers[0] || null,
    creationIdentifiers: result.creationIdentifiers,
  };
}
