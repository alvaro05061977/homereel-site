// tools/test_pipeline_wiring.mjs — do the four stages still agree with each other,
// and with Airtable's actual vocabulary?
//
// Run: node tools/test_pipeline_wiring.mjs   (no network, no credentials, free)
//
// The pipeline is a relay: produce sets a status, harvest looks for that exact
// status, the gate sets the next one, a re-run puts it back. Every handover is a
// STRING. Misspell one and nothing throws — the order simply stops, in a state
// nothing downstream is watching for, and no error is ever raised.
//
// Airtable makes that worse: a write with `typecast: true` CREATES a missing
// singleSelect option instead of rejecting it, so a typo becomes a real, silent
// new state. That is why the writes in harvest, rerun and produce send no
// typecast, and why this test exists.
//
// The vocabularies below were read from the live base on 2026-09-15. If a field's
// options change in Airtable, this test is where it should fail.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(join(here, "..", f), "utf8");

// --- what Airtable actually accepts, read from the base 2026-09-15 ---------
const PRODUCTION_STATUS = ["Claimed", "Preparing Canvas", "Rendering Keyframes", "QC Keyframes",
  "Rendering Clips", "QC Clips", "Assembling", "Awaiting Approval", "Delivering", "Delivered", "Needs Attention"];
const ROW_STATUS = ["uploaded", "composed", "approved", "ingested"];
const KEYFRAME_VERDICT = ["Pending", "Approved", "Re-run"];
const CLIP_VERDICT = ["Pending", "Approved", "Trim", "Re-run"];

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

const produce = read("lib/produce.js");
const harvest = read("lib/harvest.js");
const rerun = read("lib/rerun.js");
const gates = read("lib/gates.js");

// 1. nothing writes to Airtable with typecast on
for (const [name, src] of [["produce", produce], ["harvest", harvest], ["rerun", rerun], ["gates", gates]]) {
  ok(!/typecast:\s*true/.test(src), `${name} sends no typecast (a typo must fail, not invent an option)`);
}

// 2. every status string these files use is one Airtable knows
const quoted = (src) => [...src.matchAll(/"([^"\n]{3,40})"/g)].map((m) => m[1]);
const LOOKS_LIKE_STATUS = /^(Rendering|QC|Assembl|Deliver|Awaiting|Claimed|Preparing|Needs) /;
// Airtable FIELD names collide with this shape ("Claimed At", "Clips Done At").
// A status is never a field name, and every such field here ends in " At".
const IS_FIELD_NAME = (s) => / At$/.test(s);
for (const [name, src] of [["produce", produce], ["harvest", harvest], ["rerun", rerun], ["gates", gates]]) {
  const bad = quoted(src).filter((s) => LOOKS_LIKE_STATUS.test(s) && !IS_FIELD_NAME(s) && !PRODUCTION_STATUS.includes(s));
  ok(!bad.length, `${name} uses only real Production Status values  ${bad.length ? JSON.stringify(bad) : ""}`);
}

// 3. the relay actually joins up: what produce sets is what harvest looks for,
//    and what a re-run puts back is the same string again.
for (const s of ["Rendering Keyframes", "Rendering Clips"]) {
  ok(produce.includes(`"${s}"`), `produce can set "${s}"`);
  ok(harvest.includes(`"${s}"`), `harvest looks for "${s}"`);
  ok(rerun.includes(`"${s}"`), `a re-run puts the order back to "${s}"`);
}
for (const s of ["QC Keyframes", "QC Clips"]) {
  ok(harvest.includes(`"${s}"`), `harvest opens the gate with "${s}"`);
}

// 4. row Status: only words the field actually has
const rowStatusWrites = [...harvest.matchAll(/rowStatus:\s*"([^"]+)"/g)].map((m) => m[1]);
ok(rowStatusWrites.every((s) => ROW_STATUS.includes(s)),
   `harvest writes only real Order Photos Status values  ${JSON.stringify(rowStatusWrites)}`);
ok(!/\[F\.status\]:\s*"/.test(rerun), "a re-run does not write Status (no option means 'being redrawn')");

// 5. verdicts
ok(rerun.includes('"Pending"'), "a re-run resets the verdict to Pending, a real option on both gates");
ok(KEYFRAME_VERDICT.includes("Re-run") && CLIP_VERDICT.includes("Re-run"), "both gates offer Re-run");
ok(/thisVerdict === "Re-run"/.test(gates), "the gate check acts on a Re-run verdict");
ok(gates.indexOf("thisVerdict") < gates.indexOf("await gateStatus"),
   "the Re-run check runs BEFORE the gate count (a re-run blanks the verdict it just read)");

// 6. the node contract, shared by produce and rerun
for (const [name, src] of [["produce", produce], ["rerun", rerun]]) {
  ok(src.includes('"COMPOSE"') && src.includes('"ANIMATE"'), `${name} targets COMPOSE and ANIMATE nodes`);
  ok(src.includes('"image-generator"') && src.includes('"video-generator"'), `${name} checks the node TYPE too`);
  ok(src.includes("\u2014"), `${name} builds node names with a real em dash character, as the board uses`);
  ok(!/\$\{roomName\}\s-\s/.test(src), `${name} does not use a plain hyphen (the board has none)`);
}

// 7. both spenders price first and respect the budget
for (const [name, src] of [["produce", produce], ["rerun", rerun]]) {
  ok(src.includes("simulateNode"), `${name} prices the node before running it`);
  ok(src.includes("ORDER_BUDGET_CREDITS"), `${name} honours the credit budget`);
  ok(src.includes("creditsSpent") || src.includes("F.creditsSpent"), `${name} charges credits at start`);
}

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
