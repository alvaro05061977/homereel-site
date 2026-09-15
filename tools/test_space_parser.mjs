// tools/test_space_parser.mjs — does lib/space.js read a real board correctly?
//
// Run: node tools/test_space_parser.mjs   (no network, no credentials, free)
//
// The fixture below is verbatim from `spaces_state` on HR-0005's board
// (a28b2962…, read 2026-09-15), trimmed to eight nodes and with one name
// deliberately given a comma. It guards the one thing that must never be wrong:
// a room type on an order resolving to the RIGHT node id. A wrong id means
// running the wrong node, and a clip is 3,950 credits.
//
// If Magnific changes the shape of `spaces_state`, these tests fail here rather
// than in production — and lib/space.js is written to return nothing (so every
// caller refuses) rather than hand back a node id it is unsure of.

import { parseNodes, findNode } from "../lib/space.js";
import { canvasRoomName } from "../lib/canvas-core.js";

const toon = `board:
  uuid: a28b2962-2ba0-40fa-9cd7-924d9d0451a6
nodes[8]{id,type,name,selected,x,y,width,height,pageId,sourceNodeId,groupId,panelIndex,workflowStatus}:
  02eeee39-4ef2-47c3-961d-61bc9b7a4cba,image-generator,Kitchen — COMPOSE,false,900,1100,697,392,"1",null,1badc5b7-d6f7-430f-b068-32275245a060,null,null
  80f7e2ef-2816-4056-874f-bf18a1d08f44,video-generator,Kitchen — ANIMATE,false,2733.1,1090.39,697,392,"1",null,ac271ff9-953b-4afd-ad23-1d410a5b3bea,null,null
  ad7b3a02-9fa7-41d7-941c-5531a8df856c,image-generator,Front Exterior — COMPOSE,false,900,600,697,392,"1",null,1badc5b7-d6f7-430f-b068-32275245a060,null,null
  3ec62b16-5078-4f3f-9338-ab6f23fc822d,video-combiner,"DELIVERABLE 16:9 — Mix + End Card",false,5900,700,471,380,"1",null,null,null,idle
  18043fd1-eb42-4417-ad57-85e058564416,creation,"End Card 16:9 — exact text, appended after mix",false,5540.24,1475.49,465,278,"1",null,null,null,null
  d3e6d6d7-ca65-476a-8e13-207b33f5a252,video-combiner,Final Cut — Master,false,4278.3,1600,471,380,"1",null,null,null,idle
  1badc5b7-d6f7-430f-b068-32275245a060,panel,Keyframes,false,860,560,777,2972,"1",null,null,null,null
  f4bc27eb-554a-4bb2-bdbc-2b527d23e3ce,image-generator,Other Room — COMPOSE,false,900,3100,697,392,"1",null,1badc5b7-d6f7-430f-b068-32275245a060,null,null
connections[0]{id}:
`;
const nodes = parseNodes(toon);
let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

ok(nodes.length === 8, `parsed 8 nodes (got ${nodes.length})`);
ok(findNode(nodes, "Kitchen — COMPOSE", "image-generator").id === "02eeee39-4ef2-47c3-961d-61bc9b7a4cba", "Kitchen COMPOSE by name+type");
ok(findNode(nodes, "Kitchen — ANIMATE", "video-generator").id === "80f7e2ef-2816-4056-874f-bf18a1d08f44", "Kitchen ANIMATE by name+type");
ok(findNode(nodes, "DELIVERABLE 16:9 — Mix + End Card").id === "3ec62b16-5078-4f3f-9338-ab6f23fc822d", "quoted name matches without its quotes");
ok(findNode(nodes, "End Card 16:9 — exact text, appended after mix").id === "18043fd1-eb42-4417-ad57-85e058564416", "quoted name CONTAINING A COMMA survives");
ok(findNode(nodes, "Final Cut — Master", "video-combiner").id === "d3e6d6d7-ca65-476a-8e13-207b33f5a252", "Final Cut by name+type");

// the type filter is the guard against running the wrong kind of node
try { findNode(nodes, "Kitchen — COMPOSE", "video-generator"); ok(false, "wrong type must refuse"); }
catch { ok(true, "wrong type refuses"); }
try { findNode(nodes, "Pool — ANIMATE", "video-generator"); ok(false, "missing node must refuse"); }
catch { ok(true, "missing node refuses"); }

// room-name translation feeding the node name
ok(canvasRoomName("Primary Bedroom") === "Bedroom", "Primary Bedroom -> Bedroom");
ok(canvasRoomName("Something Else") === "Other Room", "Something Else -> Other Room");
ok(canvasRoomName({ name: "Front Exterior" }) === "Front Exterior", "Airtable singleSelect object");
ok(canvasRoomName("Wine Cellar") === null, "unknown room returns null (caller must refuse)");
ok(`${canvasRoomName("Something Else")} — COMPOSE` === "Other Room — COMPOSE", "assembled node name uses an em dash");
ok(findNode(nodes, `${canvasRoomName("Something Else")} — COMPOSE`, "image-generator").id === "f4bc27eb-554a-4bb2-bdbc-2b527d23e3ce", "end to end: room type -> node id");

ok(parseNodes("garbage") .length === 0, "garbage -> 0 nodes");
ok(parseNodes("nodes[2]{name,id,type}:\n  a,b,c").length === 0, "reordered columns -> refuse (0 nodes)");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
