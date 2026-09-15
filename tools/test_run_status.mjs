// tools/test_run_status.mjs — can we tell a FINISHED run from a running one?
//
// Run: node tools/test_run_status.mjs   (no network, no credentials, free)
//
// THE BUG THIS EXISTS FOR (HR-0006, 2026-09-15). `spaces_run_status` returned
// clean JSON through one MCP client and TOON text from inside the Vercel
// function. lib/magnific.js hands TOON back untouched as { text }, so
// `res.status` was undefined — and the old code reported that as "running".
// The render had finished two minutes earlier. Harvest would have said "still
// rendering" for ever and the gate would never have opened. Nothing errored.
//
// Both fixtures below are the REAL reply for run 9WhQ1rNYZ7.

import { parseRunStatus } from "../lib/space.js";

const JSON_SHAPE = {
  success: true, allTerminal: true, workflowRunIdentifier: "9WhQ1rNYZ7",
  status: "completed", createdAt: "2026-09-15T18:24:29.000000Z",
  completedAt: "2026-09-15T18:26:32.000000Z",
  creationIdentifiers: ["Xmq3978Bfo"],
  nodeRuns: [{ nodeId: "a4b15f4b-4689-4b97-ae30-8b0607c3b610", status: "completed", creationIdentifiers: ["Xmq3978Bfo"] }],
};

const TOON_SHAPE = { text: `success: true
allTerminal: true
workflowRunIdentifier: 9WhQ1rNYZ7
status: completed
createdAt: "2026-09-15T18:24:29.000000Z"
completedAt: "2026-09-15T18:26:32.000000Z"
creationIdentifiers[1]: Xmq3978Bfo
nodeRuns[1]{nodeId,status}:
  a4b15f4b-4689-4b97-ae30-8b0607c3b610,completed` };

const TOON_RUNNING = { text: `success: true
allTerminal: false
workflowRunIdentifier: 9WhQ1rNYZ7
status: running` };

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

let p = parseRunStatus(JSON_SHAPE);
ok(p.known && p.allTerminal && p.status === "completed", "JSON reply: finished");
ok(p.creationIdentifiers[0] === "Xmq3978Bfo", "JSON reply: the creation id");

p = parseRunStatus(TOON_SHAPE);
ok(p.known, "TOON reply: readable at all (this is the bug)");
ok(p.allTerminal === true, "TOON reply: recognised as FINISHED, not running");
ok(p.status === "completed", "TOON reply: status read");
ok(p.creationIdentifiers.includes("Xmq3978Bfo"), `TOON reply: the creation id (got ${JSON.stringify(p.creationIdentifiers)})`);

p = parseRunStatus(TOON_RUNNING);
ok(p.known && p.allTerminal === false && p.status === "running", "TOON reply: a genuinely running run still reads as running");

// the important refusal: an unreadable reply must NOT masquerade as "running"
for (const [label, bad] of [["empty object", {}], ["null", null], ["junk text", { text: "<html>502 Bad Gateway</html>" }], ["empty text", { text: "   " }]]) {
  ok(parseRunStatus(bad).known === false, `${label} -> known:false, so the caller reports it instead of guessing`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
