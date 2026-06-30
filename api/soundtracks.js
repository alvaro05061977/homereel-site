// Vercel serverless function: returns THIS WEEK'S 3 rotating soundtracks.
// The Soundtracks table holds 12 tracks split into 4 rotation groups (A-D).
// We show one group's tracks per ISO week (week mod 4), so the catalog cycles
// fully every 4 weeks. Only rows with Active checked are eligible.
//
// Env var required (already set in Vercel for /api/order):
//   AIRTABLE_TOKEN - Airtable personal access token (data.records:read on the HomeReel base)
//
// IMPORTANT: this endpoint never errors out — on any problem (no token, no
// active tracks, Airtable hiccup) it returns an empty list, and the wizard
// simply hides its Music step. That keeps the live order flow safe to deploy
// before any real audio has been uploaded.

const AIRTABLE_BASE = "apprH6McRLyr1EpY5";
const AIRTABLE_TABLE = "Soundtracks";

// ISO 8601 week number (1-53), week starts Monday.
function isoWeek(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;          // Mon=0 ... Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3);     // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((date - firstThursday) / (7 * 24 * 3600 * 1000));
}

export default async function handler(req, res) {
  const groups = ["A", "B", "C", "D"];
  const group = groups[(isoWeek(new Date()) - 1) % 4];
  const token = process.env.AIRTABLE_TOKEN;

  // Graceful no-op: no token configured -> empty catalog.
  if (!token) {
    const body = { week_group: group, tracks: [] };
    if (req.query && (req.query.debug === "1" || req.query.debug === "true")) body._noToken = true;
    res.status(200).json(body);
    return;
  }

  try {
    const params = new URLSearchParams();
    params.append("filterByFormula", `AND({Active},{Rotation Group}='${group}')`);
    params.append("sort[0][field]", "Sort Order");
    params.append("sort[0][direction]", "asc");
    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${encodeURIComponent(AIRTABLE_TABLE)}?${params.toString()}`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const debug = req.query && (req.query.debug === "1" || req.query.debug === "true");
    if (!r.ok) {
      const body = { week_group: group, tracks: [] };
      if (debug) { body._upstreamStatus = r.status; body._upstreamBody = (await r.text()).slice(0, 300); }
      res.status(200).json(body);
      return;
    }
    const d = await r.json();

    const tracks = (d.records || []).map((rec) => ({
      id: rec.id,
      name: rec.fields["Name"] || "",
      mood: rec.fields["Mood"] || "",
      tempo: rec.fields["Tempo"] || "",
      previewUrl: rec.fields["Preview URL"] || "",
    }));

    // Cache at the edge for an hour; rotation only changes weekly.
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ week_group: group, tracks });
  } catch (e) {
    const body = { week_group: group, tracks: [] };
    if (req.query && (req.query.debug === "1" || req.query.debug === "true")) body._error = String(e);
    res.status(200).json(body);
  }
}
