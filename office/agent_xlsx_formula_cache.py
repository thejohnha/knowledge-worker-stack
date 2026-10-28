#!/usr/bin/env python3
"""Evaluate a workbook's own formulas with the `formulas` engine, print them, and
(--patch) write the results into the formula cells' cached <v>, leaving <f> untouched.
Fallback for when real Excel (xlwings) is unavailable; Excel stays the primary engine.
Cells it cannot evaluate are listed under UNEVALUATED and left alone.
Usage: uv run --python 3.12 --with formulas==1.3.4 --with numpy --with openpyxl==3.1.5 python3 agent_xlsx_formula_cache.py BOOK.xlsx Sheet1[,Sheet2] [--patch]"""
import sys, os, re, zipfile, shutil, datetime as dt
import formulas, numpy as np
sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))   # agent_xlsx_surgery.py sits beside it
from agent_xlsx_surgery import sheet_path, _replace
path = sys.argv[1]; sheets = sys.argv[2].split(","); patch = "--patch" in sys.argv
xl = formulas.ExcelModel().loads(path).finish(); sol = xl.calculate()
fname = os.path.basename(path).upper()
vals = {}
for k, v in sol.items():
    m = re.match(r"'\[(.+?)\](.+?)'!([A-Z]+\d+)$", k)
    if not m or m.group(1).upper() != fname: continue
    x = v.value[0][0] if hasattr(v, "value") else v
    if isinstance(x, np.generic): x = x.item()
    vals[(m.group(2).upper(), m.group(3))] = x
with zipfile.ZipFile(path) as z:
    names = z.namelist(); data = {n: z.read(n) for n in names}
    sps = {s: sheet_path(z, s) for s in sheets}
unevaluated = []
for s, sp in sps.items():
    x = data[sp].decode()
    def fix(m):
        ref = m.group(2); attrs = m.group(1); body = m.group(3)
        v = vals.get((s.upper(), ref))
        if v is None or str(v)=="empty" or (isinstance(v, str) and v.startswith("#")) or type(v).__name__ in ("XlError",):
            unevaluated.append((s, ref, v)); return m.group(0)
        print(f"{s}!{ref} = {v!r}")
        if not patch: return m.group(0)
        f = re.search(r"<f[^>]*/>|<f[^>]*>.*?</f>", body, re.S).group(0)
        attrs = re.sub(r'\s+t="[^"]*"', "", attrs)
        if isinstance(v, bool): return f'<c{attrs} t="b">{f}<v>{int(v)}</v></c>'
        if isinstance(v, (int, float)): return f'<c{attrs}>{f}<v>{v!r}</v></c>'
        from xml.sax.saxutils import escape
        return f'<c{attrs} t="str">{f}<v>{escape(str(v))}</v></c>'
    x = re.sub(r'<c( r="([A-Z]+\d+)"[^>]*?)(?<!/)>((?:(?!</c>|<c ).)*?<f[\s>/](?:(?!</c>|<c ).)*)</c>', fix, x, flags=re.S)
    data[sp] = x.encode()
if unevaluated: print("UNEVALUATED:", unevaluated)
if patch:
    tmp = path + ".t"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names: z.writestr(n, data[n])
    _replace(tmp, path); print("patched", path)
