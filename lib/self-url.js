// lib/self-url.js — the address of this site, as seen from inside a function.
//
// One line of code, one hard-won lesson. `process.env.VERCEL_URL` is the
// DEPLOYMENT hostname (homereel-site-<hash>.vercel.app). This project has
// Vercel Authentication enabled for every *.vercel.app deployment URL, so a
// function that calls its own VERCEL_URL is an unauthenticated visitor to a
// protected site: Vercel answers 401 before our code runs. That is exactly how
// the gate doorbell failed on 2026-09-10 — it reported "triggered" and the next
// stage never started.
//
// The host the request arrived on is the public one, so use that. Behind
// Vercel's proxy the original host is in `x-forwarded-host`; `host` is the
// fallback. VERCEL_URL remains a last resort so a cron or a direct invocation
// still has something, but it is expected to fail while protection is on.
export function selfUrl(req) {
  const host =
    (req && req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) ||
    process.env.VERCEL_URL;
  if (!host) return null;
  const proto = (req && req.headers && req.headers["x-forwarded-proto"]) || "https";
  return `${proto}://${host}`;
}
