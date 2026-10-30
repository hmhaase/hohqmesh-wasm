#!/usr/bin/env python3
"""Patch the regl-line2d vertex shaders inside the pinned plotly.min.js.

Usage: patch_plotly.py <plotly.min.js> <output>

scattergl draws lines with regl-line2d, which marks line breaks with NaN
vertices. Its rect shader (used for lines up to 2 px wide) has no NaN check, its
miter shader returns without writing gl_Position, and the miter shader's join
computation turns a NaN neighbour point into NaN positions for the segments next
to a break. All of that is undefined in WebGL; some mobile GPUs draw every break
as a line to a stray point. The patch moves any segment with a NaN end point
outside the clip volume and treats a NaN neighbour like a line end, using the
NaN test the miter shader already has.

Upstream: plotly/plotly.js#3522 (closed without a fix for this cause). Remove the
patch once a Plotly release fixes regl-line2d; the build fails here when the
shader text changes, which is the cue to check.
"""
import sys
from pathlib import Path

# The shaders are JS string literals in the bundle, so newlines and tabs appear
# as \n and \t escape sequences; raw strings match them literally.
NAN_TEST = r"bool isNaN( float val ){\n  return ( val < 0.0 || 0.0 < val || val == 0.0 ) ? false : true;\n}\n\n"
NAN_GUARD = r"if (isNaN(aCoord.x) || isNaN(aCoord.y) || isNaN(bCoord.x) || isNaN(bCoord.y))"
OUTSIDE_CLIP = r"gl_Position = vec4(2.0, 2.0, 2.0, 1.0);"

RECT_MAIN = r"\nvoid main() {\n\tfloat lineStart = 1. - lineEnd;\n\tfloat lineOffset = lineTop * 2. - 1.;"
REPLACEMENTS = [
    (
        "rect shader: add NaN guard",
        RECT_MAIN,
        r"\n" + NAN_TEST + r"void main() {\n\t" + NAN_GUARD + r" {\n\t\t" + OUTSIDE_CLIP
        + r"\n\t\tfragColor = vec4(0.0);\n\t\treturn;\n\t}" + RECT_MAIN[len(r"\nvoid main() {"):],
    ),
    (
        "miter shader: write gl_Position before returning",
        r"\t" + NAN_GUARD + r" return;",
        r"\t" + NAN_GUARD + r" {\n\t\t" + OUTSIDE_CLIP + r"\n\t\treturn;\n\t}",
    ),
    (
        # The shader's own fallback for a missing neighbour is aCoord == prevCoord.
        "miter shader: treat NaN neighbours as line ends",
        r"\n\n\tif (aCoord == prevCoord) prevCoord = aCoord + normalize(bCoord - aCoord);",
        r"\n\n\tif (isNaN(prevCoord.x) || isNaN(prevCoord.y)) prevCoord = aCoord;"
        r"\n\tif (isNaN(nextCoord.x) || isNaN(nextCoord.y)) nextCoord = bCoord;"
        r"\n\tif (aCoord == prevCoord) prevCoord = aCoord + normalize(bCoord - aCoord);",
    ),
]

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
text = src.read_text()
for name, old, new in REPLACEMENTS:
    n = text.count(old)
    if n != 1:
        raise SystemExit(f"patch_plotly: {name}: expected the shader text once, found {n}")
    text = text.replace(old, new)
dst.write_text(text)
print(f"applied {len(REPLACEMENTS)} regl-line2d shader patches -> {dst}")
