#!/usr/bin/env python3
"""
HomeReel end card — exact-text renderer.

WHY NOT A GENERATIVE IMAGE NODE: this card carries the agent's phone number,
website and the mandatory AI disclosure. Image models mangle text. A wrong
phone number on a delivered film is a client-facing failure. Every glyph here
is drawn, not generated.

Output: 1920x1080 PNG (or 1080x1920 with --format 9:16), turned into a 5 s clip
by tools/endcard_clip.sh and concatenated as the film's tail.

FONTS: Fraunces + Space Grotesk. fonts.google.com is proxy-blocked from the
build container but the npm registry is not, so get them with:
    npm install @fontsource/fraunces @fontsource/space-grotesk
then convert the woff2 files to ttf with fontTools (set flavor = None).
This removes the old "Google Fonts @import won't resolve in the rasterizer"
risk flagged in homereel-build-phase-3-endcard — the fonts are now vendored.

HEADSHOT / LOGO: both live on Airtable or Cloudinary URLs, which are
proxy-blocked from the sandbox AND from device_bash. This script must therefore
run somewhere that can reach them — Vercel, alongside the wizard — or be handed
local files. It does not fetch anything itself, by design.
"""
import argparse, os
from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
FONTS = os.environ.get("HOMEREEL_FONTS", "./fonts")

DISCLOSURE = ("Lifestyle scenes are AI-generated visualizations. "
              "People shown are not actual occupants. Not for MLS use.")

PALETTES = {
    # CHOSEN 2026-08-20 by Alvaro. This settles the conflict flagged in
    # homereel-build-phase-3-endcard: "if endcard.js's warm-editorial palette
    # conflicts with the sample's look, Ivo's sample wins." It does, and it did.
    # Note #16222f is the same panel colour Alvaro used for the canvas groups.
    "navy": dict(bg="#101a26", panel="#16222f", ink="#f2f5f8", muted="#93a4b5",
                 accent="#e8442a", gold="#e6b25e", rule="#24354a"),
    # Superseded. The palette endcard.js was originally built with
    # (homereel-brand-warm-editorial). Kept only for comparison renders.
    "warm": dict(bg="#1a1410", panel="#221a14", ink="#f7efe0", muted="#b8a894",
                 accent="#e8442a", gold="#e6b25e", rule="#3a2e24"),
}
DEFAULT_PALETTE = "navy"


def f(family, weight, size):
    return ImageFont.truetype(f"{FONTS}/{family}-latin-{weight}-normal.ttf", size)


def fit(draw, text, family, weight, size, max_w, min_size=20):
    """Shrink until it fits. Never let a name or phone number overflow."""
    while size > min_size:
        font = f(family, weight, size)
        if draw.textlength(text, font=font) <= max_w:
            return font
        size -= 2
    return f(family, weight, min_size)


def wrap(draw, text, font, max_w):
    words, lines, cur = text.split(), [], ""
    for w_ in words:
        t = (cur + " " + w_).strip()
        if draw.textlength(t, font=font) <= max_w:
            cur = t
        else:
            if cur:
                lines.append(cur)
            cur = w_
    if cur:
        lines.append(cur)
    return lines


def logo_is_dark(lg, threshold=0.5):
    """Mean luminance of the logo's opaque pixels, 0..1. Below threshold = dark."""
    px = list(lg.getdata()) if not hasattr(lg, "get_flattened_data") else lg.get_flattened_data()
    tot, n = 0.0, 0
    for r, g, b, a in px:
        if a > 40:
            tot += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
            n += 1
    return n > 0 and (tot / n) < threshold


def render(out, palette, agent, brokerage, phone, website, address,
           headshot=None, logo=None):
    P = PALETTES[palette]
    img = Image.new("RGB", (W, H), P["bg"])
    d = ImageDraw.Draw(img)

    # ---- left: headshot panel -------------------------------------------
    PW = 760
    d.rectangle([0, 0, PW, H], fill=P["panel"])
    if headshot and os.path.exists(headshot):
        src = Image.open(headshot).convert("RGB")
        # cover-crop, centred - arbitrary aspect ratios must not distort a face
        sc = max(PW / src.width, H / src.height)
        src = src.resize((int(src.width * sc), int(src.height * sc)), Image.LANCZOS)
        img.paste(src.crop(((src.width - PW) // 2, (src.height - H) // 2,
                           (src.width - PW) // 2 + PW, (src.height - H) // 2 + H)), (0, 0))
    else:
        ph = f("space-grotesk", 400, 26)
        d.text((PW / 2, H / 2), "HEADSHOT", font=ph, fill=P["muted"], anchor="mm")
        d.rectangle([40, 40, PW - 40, H - 40], outline=P["rule"], width=2)

    # thin accent seam between panels
    d.rectangle([PW, 0, PW + 6, H], fill=P["accent"])

    # ---- right: branding -------------------------------------------------
    x = PW + 90
    max_w = W - x - 90
    y = 150

    if logo and os.path.exists(logo):
        lg = Image.open(logo).convert("RGBA")
        lw = min(420, lg.width)
        lg = lg.resize((lw, int(lg.height * lw / lg.width)), Image.LANCZOS)
        # A dark logo (navy text on a transparent PNG is the common case for
        # brokerages) vanishes against the navy card. Measure the logo's own
        # opaque pixels and, if they are dark, set it on a light plate so the
        # wordmark stays legible. Type-level rule, not a per-client tweak.
        if logo_is_dark(lg):
            pad = 28
            d.rounded_rectangle([x - pad, y - pad, x + lw + pad, y + lg.height + pad],
                                radius=18, fill=P["ink"])
        img.paste(lg, (x, y), lg)
        y += lg.height + 60
    else:
        d.rectangle([x, y, x + 420, y + 124], outline=P["rule"], width=2)
        d.text((x + 210, y + 62), "LOGO", font=f("space-grotesk", 400, 22),
               fill=P["muted"], anchor="mm")
        y += 184

    af = fit(d, address, "fraunces", 700, 78, max_w)
    d.text((x, y), address, font=af, fill=P["ink"])
    y += af.size + 46

    d.rectangle([x, y, x + 120, y + 4], fill=P["gold"])
    y += 54

    nf = fit(d, agent, "space-grotesk", 600, 44, max_w)
    d.text((x, y), agent, font=nf, fill=P["ink"])
    y += nf.size + 18

    bf = fit(d, brokerage, "space-grotesk", 400, 34, max_w)
    d.text((x, y), brokerage, font=bf, fill=P["muted"])
    y += bf.size + 44

    # contact - phone and website must never wrap or clip
    cf = fit(d, phone, "space-grotesk", 500, 36, max_w)
    d.text((x, y), phone, font=cf, fill=P["ink"])
    y += cf.size + 14
    wf = fit(d, website, "space-grotesk", 500, 36, max_w)
    d.text((x, y), website, font=wf, fill=P["ink"])

    # ---- disclosure strip - full width, MANDATORY (compliance) -----------
    SH = 118
    d.rectangle([0, H - SH, W, H], fill=P["accent"])
    df = f("space-grotesk", 500, 27)
    lines = wrap(d, DISCLOSURE, df, W - 160)
    ty = H - SH / 2 - (len(lines) * 34) / 2 + 17
    for ln in lines:
        d.text((W / 2, ty), ln, font=df, fill="#ffffff", anchor="mm")
        ty += 34

    img.save(out)
    return out


def render_vertical(out, palette, agent, brokerage, phone, website, address,
                    headshot=None, logo=None):
    """1080x1920 (9:16) variant: headshot on top, branding below, disclosure strip
    at the bottom. Same palette, same fonts, same exact-text rule."""
    P = PALETTES[palette]
    VW, VH = 1080, 1920
    img = Image.new("RGB", (VW, VH), P["bg"])
    d = ImageDraw.Draw(img)

    # ---- top: headshot panel ----------------------------------------------
    PH = 900
    d.rectangle([0, 0, VW, PH], fill=P["panel"])
    if headshot and os.path.exists(headshot):
        src = Image.open(headshot).convert("RGB")
        sc = max(VW / src.width, PH / src.height)
        src = src.resize((int(src.width * sc), int(src.height * sc)), Image.LANCZOS)
        img.paste(src.crop(((src.width - VW) // 2, (src.height - PH) // 2,
                           (src.width - VW) // 2 + VW, (src.height - PH) // 2 + PH)), (0, 0))
    else:
        d.text((VW / 2, PH / 2), "HEADSHOT", font=f("space-grotesk", 400, 26),
               fill=P["muted"], anchor="mm")
    d.rectangle([0, PH, VW, PH + 6], fill=P["accent"])

    # ---- bottom: branding ----------------------------------------------------
    x = 80
    max_w = VW - 2 * x
    y = PH + 90

    if logo and os.path.exists(logo):
        lg = Image.open(logo).convert("RGBA")
        lw = min(420, lg.width)
        lg = lg.resize((lw, int(lg.height * lw / lg.width)), Image.LANCZOS)
        if logo_is_dark(lg):
            pad = 24
            d.rounded_rectangle([x - pad, y - pad, x + lw + pad, y + lg.height + pad],
                                radius=18, fill=P["ink"])
        img.paste(lg, (x, y), lg)
        y += lg.height + 64

    af = fit(d, address, "fraunces", 700, 72, max_w)
    for ln in wrap(d, address, af, max_w):
        d.text((x, y), ln, font=af, fill=P["ink"])
        y += af.size + 8
    y += 34
    d.rectangle([x, y, x + 120, y + 4], fill=P["gold"])
    y += 50

    nf = fit(d, agent, "space-grotesk", 600, 44, max_w)
    d.text((x, y), agent, font=nf, fill=P["ink"])
    y += nf.size + 16
    bf = fit(d, brokerage, "space-grotesk", 400, 32, max_w)
    d.text((x, y), brokerage, font=bf, fill=P["muted"])
    y += bf.size + 40
    cf = fit(d, phone, "space-grotesk", 500, 36, max_w)
    d.text((x, y), phone, font=cf, fill=P["ink"])
    y += cf.size + 14
    wf = fit(d, website, "space-grotesk", 500, 36, max_w)
    d.text((x, y), website, font=wf, fill=P["ink"])

    # ---- disclosure strip - MANDATORY (compliance) ---------------------------
    df = f("space-grotesk", 500, 26)
    lines = wrap(d, DISCLOSURE, df, VW - 120)
    SH = 60 + len(lines) * 34
    d.rectangle([0, VH - SH, VW, VH], fill=P["accent"])
    ty = VH - SH / 2 - (len(lines) * 34) / 2 + 17
    for ln in lines:
        d.text((VW / 2, ty), ln, font=df, fill="#ffffff", anchor="mm")
        ty += 34

    img.save(out)
    return out


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--out", required=True)
    p.add_argument("--palette", default=DEFAULT_PALETTE, choices=list(PALETTES))
    p.add_argument("--agent", required=True)
    p.add_argument("--brokerage", required=True)
    p.add_argument("--phone", required=True)
    p.add_argument("--website", required=True)
    p.add_argument("--address", required=True)
    p.add_argument("--headshot")
    p.add_argument("--logo")
    p.add_argument("--format", default="16:9", choices=["16:9", "9:16"],
                   help="16:9 = 1920x1080 (default); 9:16 = 1080x1920 for the vertical cut")
    a = p.parse_args()
    fn = render_vertical if a.format == "9:16" else render
    print(fn(a.out, a.palette, a.agent, a.brokerage, a.phone, a.website,
             a.address, a.headshot, a.logo))
