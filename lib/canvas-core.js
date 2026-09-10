// lib/canvas-core.js — room-name translation, plus a retired stub.
//
// ⚠ WHAT THIS FILE USED TO DO, AND WHY IT NO LONGER DOES IT.
//
// It used to take an approved keyframe, ingest it into Magnific, and place it
// on the client's Space as a separate "<Room> — APPROVED KEYFRAME" node wired
// into that room's ANIMATE first-frame input. Two callers used it: api/qc.js
// on approval, and api/canvas-sync.js over HTTP for manual replays.
//
// Retired 2026-09-10, build spec P1.7. Alvaro's rule of 2026-09-08 is that
// **the Space IS the pipeline**: every COMPOSE and ANIMATE node renders on the
// client's Space and holds its own output, approval means "this node's current
// output is the approved take", and ANIMATE reads its own COMPOSE directly.
// Under that shape there is nothing to sync. Worse, a side node holding an
// approved render is exactly what made HR-0005's Space unreadable, and Magnific
// will not let a generator node adopt an existing creation anyway (tested
// 2026-09-08: the edit reports success and does nothing).
//
// `api/canvas-sync.js` was deleted in the same commit. `syncApprovedKeyframe`
// survives as a logging stub so anything still importing it says so in the log
// instead of failing mysteriously.
//
// WHAT IS STILL LIVE HERE: the room-name map below. The wizard's Room Type
// labels and the canvas node names disagree on several rooms, and this is the
// only place that translation exists. The Flow input map needs it too.

import { MagnificError as CanvasSyncError } from "./magnific.js";

// One error class, two names. lib/magnific.js owns it; this alias is the SAME
// class object, so any `instanceof CanvasSyncError` still matches.
export { CanvasSyncError };

// Wizard Room Type labels -> canvas room names.
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

// Accepts either a plain string or Airtable's singleSelect object.
// Returns null for anything unrecognised — callers must treat that as an error,
// not as a default, because guessing a room silently would put a kitchen scene
// in a bedroom.
export function canvasRoomName(roomType) {
  const raw = typeof roomType === "object" ? roomType?.name : roomType;
  return ROOM_ALIASES.get(String(raw || "").trim().toLowerCase()) || null;
}

// RETIRED — see the header. Does nothing, on purpose.
export async function syncApprovedKeyframe(recordId) {
  console.log(
    "[canvas-core] syncApprovedKeyframe is RETIRED and did nothing (build spec P1.7, 2026-09-10). " +
    "The Space is the pipeline; ANIMATE reads its own COMPOSE. recordId:", recordId
  );
  return {
    synced: false,
    retired: true,
    reason: "syncApprovedKeyframe was retired in build spec P1.7 — the Space is the pipeline",
  };
}
