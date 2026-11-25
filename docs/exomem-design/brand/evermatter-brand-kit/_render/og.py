"""Build the Evermatter social card (1200 x 630) as one SVG with outlined text.

Layout follows the Exomem card (raster.json, social/og-image.png): the graph band on
top, the fade, the logo at left 96, the tagline and the app line below. The logo is the
initial wordmark (the Dot E inside the name), not the mark beside the name.
Usage: og.py RASTER_JSON WORDMARK_SVG OUT_SVG
"""
import json
import os
import re
import sys

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

INTER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fonts", "Inter-var.ttf")


def text_path(size, text, x, baseline, tracking=0.0):
    """Shape text with HarfBuzz (kerning included) in Inter 400 at its optical size.
    `tracking` is CSS letter-spacing in em, added after each glyph."""
    opsz = max(14, min(32, size))
    font = instantiateVariableFont(TTFont(INTER), {"wght": 400, "opsz": opsz})
    upm = font["head"].unitsPerEm
    blob = hb.Blob.from_file_path(INTER)
    hbf = hb.Font(hb.Face(blob))
    hbf.set_variations({"wght": 400, "opsz": opsz})
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hbf, buf, {"kern": True, "liga": True})
    gs = font.getGlyphSet()
    order = font.getGlyphOrder()
    s = size / upm
    pen = SVGPathPen(gs, ntos=lambda v: ("%.2f" % v).rstrip("0").rstrip("."))
    pen_x = 0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        name = order[info.codepoint]
        t = (s, 0, 0, -s, x + (pen_x + pos.x_offset) * s, baseline - pos.y_offset * s)
        gs[name].draw(TransformPen(pen, t))
        pen_x += pos.x_advance + tracking * upm
    return pen.getCommands()


def main(raster_json, wordmark_svg, out_svg):
    src = json.load(open(raster_json))["social/og-image.png"][2]
    # The inputs are this kit's own fixed files: the archived card (an HTML fragment) and
    # a lockup SVG. The regexes lift their exact markup unchanged into the new card; a
    # parser would re-serialise it (namespace prefixes, attribute order).
    band = re.search(r'<svg viewBox="0 0 600 120"[^>]*>(.*?)</svg>', src, re.S).group(1)
    wm = open(wordmark_svg).read()
    vb = re.search(r'viewBox="([^"]+)"', wm).group(1)
    inner = re.search(r"</title>(.*)</svg>", wm, re.S).group(1)
    vx, vy, vw, vh = map(float, vb.split())
    cap = 88.0  # cap height of the logo on the card: the old mark's 89 px, on whole pixels
    h = cap * vh / -vy  # the viewBox runs from the cap line (vy) to just below the baseline
    w = h * vw / vh
    asc = 1984 / 2048  # Inter ascent: a CSS line box puts the baseline at top + ascent
    tag = text_path(38, "One memory every assistant shares.", 96, 418 + 38 * asc, tracking=-0.01)
    apps = text_path(24, "Claude · ChatGPT · Claude Code · Codex", 96, 478 + 24 * asc)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<title>Evermatter</title>
<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0A0908" stop-opacity="0"/><stop offset="1" stop-color="#0A0908"/></linearGradient></defs>
<rect width="1200" height="630" fill="#0A0908"/>
<svg x="0" y="0" width="1200" height="240" viewBox="0 0 600 120" opacity="0.9">{band}</svg>
<rect x="0" y="120" width="1200" height="160" fill="url(#fade)"/>
<svg x="96" y="266" width="{w:.2f}" height="{h:.2f}" viewBox="{vb}">{inner}</svg>
<path d="{tag}" fill="#C9C5BC"/>
<path d="{apps}" fill="#858075"/>
</svg>"""
    open(out_svg, "w").write(svg)
    print(json.dumps({"logo": [96, 266, round(w, 2), round(h, 2)], "baseline": 266 + cap}))


if __name__ == "__main__":
    main(*sys.argv[1:4])
