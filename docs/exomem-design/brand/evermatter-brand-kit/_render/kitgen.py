"""Rebuild the Exomem lockup SVGs for Evermatter, keeping each file's construction.

For each source file the word path's placement (scale k, origin tx, baseline ty) is
recovered by fitting its ink box to the same word outlined from the font at 40 units
per em. The new word is outlined with that same placement, so the type size, the gap
after the mark and the baseline stay exactly as the kit drew them. The viewBox is then
rebuilt to hug the ink of the mark plus the new word. Stacked files re-centre the word
under the mark.

Usage: kitgen.py SRC_DIR OUT_DIR VARIANT   (VARIANT: mono | caps | sans)
"""
import json
import os
import re
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, "..", "fonts")
MONO = os.path.join(FONTS, "IBMPlexMono-Medium.ttf")
SANS = os.path.join(FONTS, "IBMPlexSans-Medium.ttf")

# What each variant writes. "tail" follows the Dot E as its capital; "plain" is the
# whole name in type, used where the kit sets the name beside or under the mark.
VARIANTS = {
    "mono": {"font": MONO, "tail": "vermatter", "plain": "evermatter"},
    "caps": {"font": MONO, "tail": "VERMATTER", "plain": "EVERMATTER"},
    "sans": {"font": SANS, "tail": "vermatter", "plain": "evermatter"},
}

# Which word each source file draws, and where its first advance box starts at 40/em.
# The initial wordmarks start the tail one mono cell (24 units) after the E's cell.
SOURCES = {
    "exomem-wordmark-initial": ("xomem", 24, "tail"),
    "exomem-wordmark-initial-on-light": ("xomem", 24, "tail"),
    "exomem-wordmark-initial-mono": ("xomem", 24, "tail"),
    "exomem-wordmark-initial-small": ("xomem", 24, "tail"),
    "exomem-wordmark-initial-small-on-light": ("xomem", 24, "tail"),
    "exomem-wordmark": ("exomem", 0, "plain"),
    "exomem-wordmark-on-light": ("exomem", 0, "plain"),
    "exomem-lockup": ("exomem", 0, "plain"),
    "exomem-lockup-on-light": ("exomem", 0, "plain"),
    "exomem-lockup-stacked": ("exomem", 0, "plain"),
    "exomem-lockup-stacked-on-light": ("exomem", 0, "plain"),
}

_fonts = {}


def glyph_run(font_path, text, x0, pen_t):
    """Draw text from font_path at 40/em, then through the affine pen_t, into a recording."""
    if font_path not in _fonts:
        _fonts[font_path] = TTFont(font_path)
    font = _fonts[font_path]
    s = 40.0 / font["head"].unitsPerEm
    cmap, gs, hmtx = font.getBestCmap(), font.getGlyphSet(), font["hmtx"]
    rec = RecordingPen()
    x = x0
    for ch in text:
        name = cmap[ord(ch)]
        k, tx, ty = pen_t
        # glyph units -> 40/em (y up -> down) -> file placement
        gs[name].draw(TransformPen(rec, (k * s, 0, 0, -k * s, k * x + tx, ty)))
        x += hmtx[name][0] * s
    return rec


def bounds_of(rec):
    b = BoundsPen(None)
    rec.replay(b)
    return b.bounds


def path_of(rec, dx=0.0):
    pen = SVGPathPen(None, ntos=lambda v: ("%.3f" % v).rstrip("0").rstrip("."))
    rec.replay(TransformPen(pen, (1, 0, 0, 1, dx, 0)))
    return pen.getCommands()


def mark_bounds(svg):
    m = re.search(r'<g transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([-\d.]+)\)">', svg)
    if not m:
        return None
    tx, ty, k = map(float, m.groups())
    xs, ys = [], []
    for cx, cy, r in re.findall(r'<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"', svg):
        cx, cy, r = float(cx), float(cy), float(r)
        xs += [tx + k * (cx - r), tx + k * (cx + r)]
        ys += [ty + k * (cy - r), ty + k * (cy + r)]
    return (min(xs), min(ys), max(xs), max(ys))


def rebuild(svg, ref_word, ref_x0, role, variant):
    v = VARIANTS[variant]
    d_old = re.search(r'<path d="([^"]+)"', svg).group(1)
    old = RecordingPen()
    parse_path(d_old, old)
    ob = bounds_of(old)
    ref = bounds_of(glyph_run(MONO, ref_word, ref_x0, (1, 0, 0)))
    k = (ob[2] - ob[0]) / (ref[2] - ref[0])
    k_h = (ob[3] - ob[1]) / (ref[3] - ref[1])
    assert abs(k - k_h) < 1e-3, f"placement fit disagrees: width {k} height {k_h}"
    tx, ty = ob[0] - k * ref[0], ob[3] - k * ref[3]
    # Check the fit reproduces the old path's box before trusting it.
    chk = bounds_of(glyph_run(MONO, ref_word, ref_x0, (k, tx, ty)))
    assert all(abs(a - b) < 0.01 for a, b in zip(chk, ob)), f"fit check failed {chk} vs {ob}"

    text = v[role]
    new = glyph_run(v["font"], text, ref_x0, (k, tx, ty))
    nb = bounds_of(new)
    mb = mark_bounds(svg)
    dx = 0.0
    stacked = mb is not None and mb[3] <= ob[1] + 0.01  # mark sits above the word
    if stacked:
        dx = (mb[0] + mb[2]) / 2 - (nb[0] + nb[2]) / 2
        nb = (nb[0] + dx, nb[1], nb[2] + dx, nb[3])
    elif mb is not None and role == "plain":
        # The mark beside the name stands on the baseline and reaches the cap line, as the
        # Dot E does inside the initial wordmark (and as the t of "evermatter" does). The
        # Exomem lockup centred it on the x-height of a word with no tall letters.
        m_old = re.search(r'scale\(([-\d.]+)\)', svg).group(1)
        cap = 27.92 * k  # Plex Mono cap height (698/1000 em at 40 units/em), placed
        m = cap / 35.6  # Dot E ink height in mark units
        gx = mb[0] - 11.4 * m
        gy = (ty - cap) - 6.2 * m
        svg = re.sub(r'<g transform="translate\([-\d.]+ [-\d.]+\) scale\([-\d.]+\)">',
                     f'<g transform="translate({gx:.3f} {gy:.3f}) scale({m:.4f})">', svg, count=1)
        gap = (ob[0] - mb[2]) * m / float(m_old)
        dx = (mb[0] + 25.2 * m + gap) - nb[0]
        nb = (nb[0] + dx, nb[1], nb[2] + dx, nb[3])
        mb = mark_bounds(svg)
    boxes = [nb] + ([mb] if mb else [])
    x0 = min(b[0] for b in boxes)
    y0 = min(b[1] for b in boxes)
    x1 = max(b[2] for b in boxes)
    y1 = max(b[3] for b in boxes)
    w, h = x1 - x0, y1 - y0
    out = svg.replace(d_old, path_of(new, dx))
    out = re.sub(r'viewBox="[^"]*"', f'viewBox="{x0:.2f} {y0:.2f} {w:.2f} {h:.2f}"', out, count=1)
    # Exact size, not rounded: a rounded box letterboxes the ink inside it by up to half a unit.
    out = re.sub(r'width="[\d.]+" height="[\d.]+"', f'width="{w:.2f}" height="{h:.2f}"', out, count=1)
    out = out.replace('aria-label="Exomem"', 'aria-label="Evermatter"').replace("<title>Exomem</title>", "<title>Evermatter</title>")
    info = {"viewBox": [round(x0, 2), round(y0, 2), round(w, 2), round(h, 2)], "k": round(k, 4)}
    if mb is not None and not stacked:
        # Distance of the mark's ink from the word's cap line and baseline (0 = aligned).
        info["mark_top_vs_cap"] = round(mb[1] - (ty - 27.92 * k), 3)
        info["mark_bottom_vs_base"] = round(mb[3] - ty, 3)
        info["word_top_vs_cap"] = round(nb[1] - (ty - 27.92 * k), 3)
    return out, info


def main(src, dst, variant):
    os.makedirs(dst, exist_ok=True)
    report = {}
    for stem, (word, x0, role) in SOURCES.items():
        with open(os.path.join(src, stem + ".svg")) as f:
            svg = f.read()
        out, info = rebuild(svg, word, x0, role, variant)
        name = stem.replace("exomem", "evermatter") + ".svg"
        with open(os.path.join(dst, name), "w") as f:
            f.write(out)
        report[name] = info
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
