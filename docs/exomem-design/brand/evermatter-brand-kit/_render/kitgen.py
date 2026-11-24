"""Rebuild the Exomem lockup SVGs for Evermatter, keeping each file's construction.

For each source file the word path's placement (scale k, origin tx, baseline ty) is
recovered by fitting its ink box to the same word outlined from the font at 40 units
per em. The new word is outlined with that same placement, so the type size, the gap
after the mark and the baseline stay exactly as the kit drew them. The viewBox is then
rebuilt to hug the ink of the mark plus the new word. Stacked files re-centre the word
under the mark; horizontal lockups stand the mark on the baseline up to the cap line.

Usage: kitgen.py SRC_DIR OUT_DIR   (SRC_DIR: the Exomem lockup folder)
"""
import json
import os
import sys
import xml.etree.ElementTree as ET

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = TTFont(os.path.join(HERE, "..", "fonts", "IBMPlexMono-Medium.ttf"))
EM = 40.0  # the kit draws type at 40 units per em
CAP = FONT["OS/2"].sCapHeight * EM / FONT["head"].unitsPerEm  # 27.92 for Plex Mono
NS = {"svg": "http://www.w3.org/2000/svg"}

TAIL, PLAIN = "vermatter", "evermatter"  # after the Dot E as capital; the whole name in type

# Which word each source file draws, and where its first advance box starts at 40/em.
# The initial wordmarks start the tail one mono cell (24 units) after the E's cell.
SOURCES = {
    "exomem-wordmark-initial": ("xomem", 24, TAIL),
    "exomem-wordmark-initial-on-light": ("xomem", 24, TAIL),
    "exomem-wordmark-initial-mono": ("xomem", 24, TAIL),
    "exomem-wordmark-initial-small": ("xomem", 24, TAIL),
    "exomem-wordmark-initial-small-on-light": ("xomem", 24, TAIL),
    "exomem-wordmark": ("exomem", 0, PLAIN),
    "exomem-wordmark-on-light": ("exomem", 0, PLAIN),
    "exomem-lockup": ("exomem", 0, PLAIN),
    "exomem-lockup-on-light": ("exomem", 0, PLAIN),
    "exomem-lockup-stacked": ("exomem", 0, PLAIN),
    "exomem-lockup-stacked-on-light": ("exomem", 0, PLAIN),
}


def glyph_run(text, x0, k, tx, ty):
    """Text at 40/em from x0 (y up -> down), then placed by scale k and offset (tx, ty)."""
    s = EM / FONT["head"].unitsPerEm
    cmap, gs, hmtx = FONT.getBestCmap(), FONT.getGlyphSet(), FONT["hmtx"]
    rec = RecordingPen()
    x = x0
    for ch in text:
        name = cmap[ord(ch)]
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


def parse_transform(t):
    """The kit writes the mark group as 'translate(x y) scale(s)' and nothing else."""
    tr = t.split("translate(")[1].split(")")[0].split()
    sc = t.split("scale(")[1].split(")")[0]
    return float(tr[0]), float(tr[1]), float(sc)


def read(svg_text):
    """Read the word path, the mark group's placement and its dots' box in mark units."""
    root = ET.fromstring(svg_text)
    d = root.find("svg:path", NS).get("d")
    g = root.find("svg:g", NS)
    if g is None:
        return d, None, None
    dots = [(float(c.get("cx")), float(c.get("cy")), float(c.get("r"))) for c in g.findall("svg:circle", NS)]
    ink = (min(x - r for x, _, r in dots), min(y - r for _, y, r in dots),
           max(x + r for x, _, r in dots), max(y + r for _, y, r in dots))
    return d, (g.get("transform"), parse_transform(g.get("transform"))), ink


def placed(ink, t):
    tx, ty, k = t
    return (tx + k * ink[0], ty + k * ink[1], tx + k * ink[2], ty + k * ink[3])


def rebuild(svg, ref_word, ref_x0, text):
    d_old, group, ink = read(svg)
    old = RecordingPen()
    parse_path(d_old, old)
    ob = bounds_of(old)
    ref = bounds_of(glyph_run(ref_word, ref_x0, 1, 0, 0))
    k = (ob[2] - ob[0]) / (ref[2] - ref[0])
    k_h = (ob[3] - ob[1]) / (ref[3] - ref[1])
    assert abs(k - k_h) < 1e-3, f"placement fit disagrees: width {k} height {k_h}"
    tx, ty = ob[0] - k * ref[0], ob[3] - k * ref[3]
    # Check the fit reproduces the old path's box before trusting it.
    chk = bounds_of(glyph_run(ref_word, ref_x0, k, tx, ty))
    assert all(abs(a - b) < 0.01 for a, b in zip(chk, ob)), f"fit check failed {chk} vs {ob}"

    new = glyph_run(text, ref_x0, k, tx, ty)
    nb = bounds_of(new)
    mb = placed(ink, group[1]) if group else None
    out = svg
    dx = 0.0
    stacked = mb is not None and mb[3] <= ob[1] + 0.01  # mark sits above the word
    if stacked:
        dx = (mb[0] + mb[2]) / 2 - (nb[0] + nb[2]) / 2
    elif mb is not None and text == PLAIN:
        # The mark beside the name stands on the baseline and reaches the cap line, as the
        # Dot E does inside the initial wordmark (and as the t of "evermatter" does). The
        # Exomem lockup centred it on the x-height of a word with no tall letters.
        cap = CAP * k
        m = cap / (ink[3] - ink[1])
        gx, gy = mb[0] - ink[0] * m, (ty - cap) - ink[1] * m
        out = out.replace(f'transform="{group[0]}"', f'transform="translate({gx:.3f} {gy:.3f}) scale({m:.4f})"', 1)
        gap = (ob[0] - mb[2]) * m / group[1][2]
        mb = placed(ink, (gx, gy, m))
        dx = (mb[2] + gap) - nb[0]
    nb = (nb[0] + dx, nb[1], nb[2] + dx, nb[3])
    boxes = [nb] + ([mb] if mb else [])
    x0, y0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    w, h = max(b[2] for b in boxes) - x0, max(b[3] for b in boxes) - y0

    # Writes replace exact attribute strings read above, so the kit's bytes stay as they
    # were outside the word, the viewBox and the size; a parser would re-serialise them.
    root = ET.fromstring(svg)
    out = out.replace(f'd="{d_old}"', f'd="{path_of(new, dx)}"', 1)
    out = out.replace(f'viewBox="{root.get("viewBox")}"', f'viewBox="{x0:.2f} {y0:.2f} {w:.2f} {h:.2f}"', 1)
    # Exact size, not rounded: a rounded box letterboxes the ink inside it by up to half a unit.
    out = out.replace(f'width="{root.get("width")}" height="{root.get("height")}"', f'width="{w:.2f}" height="{h:.2f}"', 1)
    out = out.replace('aria-label="Exomem"', 'aria-label="Evermatter"').replace("<title>Exomem</title>", "<title>Evermatter</title>")

    info = {"viewBox": [round(v, 2) for v in (x0, y0, w, h)]}
    if mb is not None and not stacked:
        # Distance of the mark's and the word's ink from the cap line and baseline (0 = aligned).
        info["mark_top_vs_cap"] = round(mb[1] - (ty - CAP * k), 3)
        info["mark_bottom_vs_base"] = round(mb[3] - ty, 3)
        info["word_top_vs_cap"] = round(nb[1] - (ty - CAP * k), 3)
    return out, info


def main(src, dst):
    os.makedirs(dst, exist_ok=True)
    report = {}
    for stem, (word, x0, text) in SOURCES.items():
        with open(os.path.join(src, stem + ".svg")) as f:
            out, info = rebuild(f.read(), word, x0, text)
        name = stem.replace("exomem", "evermatter") + ".svg"
        with open(os.path.join(dst, name), "w") as f:
            f.write(out)
        report[name] = info
    print(json.dumps(report, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
