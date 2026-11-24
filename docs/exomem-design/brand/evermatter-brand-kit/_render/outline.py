"""Outline a word from a TTF into one SVG path, in the kit's units.

The kit draws type at 40 units per em (Plex Mono cap height 27.92 = the Dot E's height),
baseline at y = 0, y pointing down. `x0` is where the first glyph's advance box starts.
Usage: outline.py FONT TEXT X0 [EM]  -> prints JSON {path, ink: [x0, y0, x1, y1], advance_end}
"""
import json
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont


def outline(font_path, text, x0, em=40.0):
    font = TTFont(font_path)
    upm = font["head"].unitsPerEm
    s = em / upm
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    hmtx = font["hmtx"]
    svg = SVGPathPen(gs, ntos=lambda v: ("%.3f" % v).rstrip("0").rstrip("."))
    bounds = BoundsPen(gs)
    x = x0
    for ch in text:
        name = cmap[ord(ch)]
        t = (s, 0, 0, -s, x, 0)
        gs[name].draw(TransformPen(svg, t))
        gs[name].draw(TransformPen(bounds, t))
        x += hmtx[name][0] * s
    return {"path": svg.getCommands(), "ink": [round(v, 3) for v in bounds.bounds], "advance_end": round(x, 3)}


if __name__ == "__main__":
    em = float(sys.argv[4]) if len(sys.argv) > 4 else 40.0
    print(json.dumps(outline(sys.argv[1], sys.argv[2], float(sys.argv[3]), em)))
