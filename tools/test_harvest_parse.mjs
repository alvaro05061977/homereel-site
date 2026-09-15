// tools/test_harvest_parse.mjs — does harvest pick the RIGHT url out of a creation?
//
// Run: node tools/test_harvest_parse.mjs   (no network, no credentials, free)
//
// `creations_get` answers in JSON sometimes and TOON other times, and a TOON
// answer buries EIGHT more `url:` lines under metadata.mediaCollection — the
// four reference images fed to the node, a preview grid, the start and end
// frames, and the audio track. Pick the wrong one and Gate 2 shows a reviewer a
// still photograph of somebody's kitchen and calls it the clip.
//
// The fixture is trimmed verbatim from a real creations_get on P3ZKbWN42C
// (HR-0005's approved Front Exterior clip), read 2026-09-15.

import { creationUrl, creationStatus } from "../lib/harvest.js";

const TOON = `identifier: P3ZKbWN42C
family: 88cb767b-3950-4d85-b7e6-e1ec121971bd
tool: video-generator
kind: video
status: completed
url: "https://pikaso.cdnpk.net/private/production/5212445420/video.mp4?token=exp=1789776000~hmac=37ab6ad7"
thumbnailUrl: "https://pikaso.cdnpk.net/private/production/5212445657/start_frame.jpg?token=exp=1789776000"
createdAt: "2026-08-19T22:41:09+00:00"
metadata:
  prompt: "The family is already walking up the front walkway from the first frame."
  mode: pro-2.0
  duration: 5
  mediaCollection[9]:
    - type: video
      url: "https://pikaso.cdnpk.net/private/production/5212445420/video.mp4?token=exp=1789776000"
    - type: reference
      index: 0
      url: "https://pikaso.cdnpk.net/private/production/5212445462/reference_0?token=exp=1789776000"
    - type: reference
      index: 1
      url: "https://pikaso.cdnpk.net/private/production/5212445489/reference_1?token=exp=1789776000"
    - type: preview-grid
      url: "https://pikaso.cdnpk.net/private/production/5212445619/preview-grid.webp?token=exp=1789776000"
    - type: frame
      index: 0
      url: "https://pikaso.cdnpk.net/private/production/5212445657/start_frame.jpg?token=exp=1789776000"
    - type: audio
      url: "https://pikaso.cdnpk.net/private/production/5212445668/audio.mp3?token=exp=1789776000"
  credits: 3500
webUrl: "https://www.magnific.com/app/creation/P3ZKbWN42C"`;

let fail = 0;
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) fail++; };

const url = creationUrl({ text: TOON });
ok(url === "https://pikaso.cdnpk.net/private/production/5212445420/video.mp4?token=exp=1789776000~hmac=37ab6ad7",
   `TOON: picks the top-level video url, whole and unquoted (got ${url})`);
ok(!String(url).includes("reference"), "TOON: does NOT pick a reference image");
ok(!String(url).includes("start_frame"), "TOON: does NOT pick the start frame");
ok(!String(url).includes("preview-grid"), "TOON: does NOT pick the preview grid");
ok(!String(url).includes("audio"), "TOON: does NOT pick the audio track");
ok(!String(url).includes("magnific.com"), "TOON: does NOT pick webUrl (that is a web page, not a file)");
ok(creationStatus({ text: TOON }) === "completed", "TOON: reads the status");

// the JSON shape of the same answer
const JSONY = { identifier: "P3ZKbWN42C", status: "completed", url: "https://example.test/video.mp4", webUrl: "https://www.magnific.com/app/creation/P3ZKbWN42C" };
ok(creationUrl(JSONY) === "https://example.test/video.mp4", "JSON: picks .url");
ok(creationStatus(JSONY) === "completed", "JSON: reads .status");

// refusals — a null must never be filed as a render
ok(creationUrl({ text: "identifier: X\nstatus: processing" }) === null, "no url yet -> null, caller refuses");
ok(creationUrl({}) === null, "empty object -> null");
ok(creationUrl(null) === null, "null -> null");
ok(creationUrl({ text: "  url: \"https://indented.test/nope\"" }) === null, "an INDENTED url is never the top-level one");
ok(creationStatus({ text: "identifier: X" }) === null, "no status -> null");

console.log(fail ? `\n${fail} FAILED` : "\nall passed");
process.exit(fail ? 1 : 0);
