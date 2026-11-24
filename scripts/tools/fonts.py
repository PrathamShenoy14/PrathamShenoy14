"""Subset the panel fonts to ASCII plus a few symbols and write advance-width metrics.

Run once after changing fonts: python scripts/tools/fonts.py  (needs fonttools + brotli).
The build itself only needs Node.js.
"""
import json, pathlib
from fontTools.ttLib import TTFont
from fontTools import subset

ROOT = pathlib.Path(__file__).resolve().parents[2] / "assets" / "fonts"
EXTRA = "·—–’→↗•"
CHARS = "".join(chr(c) for c in range(0x20, 0x7F)) + EXTRA
metrics = {}
for src in sorted(ROOT.glob("*.woff2")):
    if src.stem.endswith(".subset"):
        continue
    font = TTFont(src)
    cmap, hmtx, upm = font.getBestCmap(), font["hmtx"], font["head"].unitsPerEm
    present = [ch for ch in CHARS if ord(ch) in cmap]
    metrics[src.stem] = {ch: round(hmtx[cmap[ord(ch)]][0] / upm, 4) for ch in present}
    opts = subset.Options(); opts.flavor = "woff2"; opts.layout_features = ["kern", "liga"]
    opts.name_IDs = []; opts.notdef_outline = True
    s = subset.Subsetter(opts); s.populate(text="".join(present)); s.subset(font)
    out = src.with_name(src.stem + ".subset.woff2"); font.flavor = "woff2"; font.save(out)
    missing = [ch for ch in CHARS if ch not in present]
    print(src.stem, out.stat().st_size, "bytes; missing:", "".join(missing))
(ROOT / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
