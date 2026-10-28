"""agent_xlsx_surgery — edit an .xlsx by rewriting its sheet XML, not by round-tripping it.

WHY IT EXISTS. The usual ways to change a workbook from a script both fail:

  * openpyxl load/save DROPS every cached formula value in the whole workbook, drops
    pivot tables and defined names, and moves formula strings VERBATIM on insert_cols,
    so a relative cascade silently points one column wrong.
  * xlwings needs real Excel over Apple events, and the process driving it needs a
    macOS Automation grant it may not have.

So these four operations edit the sheet XML in place. Every byte of every cell they
are not asked to touch stays exactly as it was, which is what preserves cached values,
formats, pivots and named ranges by construction rather than by care.

  append_rows(path, sheet, rows, ncols)          add rows after the last one
  replace_row(path, sheet, rownum, vals, ref, n) fill a pre-styled EMPTY row in place
  set_cells(path, sheet, {(r, c): v}, style_from_col=None)   set scattered cells
  insert_column(path, sheet, at, new_cells=None) insert a column, re-pointing refs

A value is None, a number, a str, a bool, a datetime, or Formula("A1+B1") — written
WITHOUT the leading "=", the way Excel stores a formula inside the file.

STYLE RULE, common to all four: a new cell copies the style INDEX of a neighbor —
the cell above for a row append, the same column in a reference row for a row
replace, the named column for set_cells. Copying the index inherits number format,
fill, font, border and alignment exactly, rather than patching attributes one by one.

THE COLUMN INSERT is the one with real risk, so it carries its own proof. It shifts
cell addresses, unqualified A1 references inside every formula, shared-formula master
ranges, <cols> widths, <dimension> and <hyperlink> refs. A reference carrying a sheet
qualifier (Prices!$A:$B) names another sheet and is left alone. It then shifts
every formula BACK and asserts the result is the original byte for byte; a formula it
cannot round-trip raises instead of being written. It REFUSES a shared-formula range
that straddles the insert column, because splitting one needs the master re-expanded.

CALLER STILL OWES, because this module does not know about them:
  * xl/calcChain.xml goes stale after an insert — delete the part (Excel rebuilds it).
  * comment refs (xl/comments*.xml) and their VML anchors — shift_comments() does it.
  * other sheets' formulas that point INTO the edited sheet, and defined names, are
    not re-pointed by insert_column.
  * every write sets fullCalcOnLoad, so Excel recomputes when the file is opened;
    until then the new formula cells carry no cached value and a data_only read
    of them returns None. Run agent_xlsx_formula_cache.py --patch, or open and save
    the file in Excel, before reading them.
  * set_cells' style_from_col / style_from_row apply ONLY to a cell the call has to
    CREATE. Writing to a cell that already exists in the sheet XML -- an empty one
    counts, and a row carrying spans="1:4" usually has it -- sets the value and leaves
    the existing style index untouched, with no warning. A batch can therefore come
    out half styled. VERIFY STYLE, NOT ONLY VALUE: compare the s="..." attribute
    against a known-good neighbor, or diff the style indexes against a pre-edit copy.
  * every function writes the file IN PLACE. Work on a copy.
"""
import re, shutil, zipfile, datetime as dt
from xml.sax.saxutils import escape

EPOCH = dt.datetime(1899, 12, 30)

def _replace(tmp, path):
    # the rewrite is a NEW file and would take the umask; keep the original's mode
    shutil.copymode(path, tmp)
    shutil.move(tmp, path)


# --- append ----------------------------------------------
EPOCH = dt.datetime(1899, 12, 30)

def col_letter(n):
    s = ""
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s

def excel_serial(d):
    delta = d - EPOCH
    if delta.seconds or delta.microseconds:
        return delta.days + (delta.seconds + delta.microseconds / 1e6) / 86400.0
    return delta.days

def sheet_path(z, name):
    wb = z.read("xl/workbook.xml").decode("utf-8")
    rels = z.read("xl/_rels/workbook.xml.rels").decode("utf-8")
    m = re.search(r'<sheet[^>]*name="%s"[^>]*r:id="([^"]+)"' % re.escape(name), wb)
    if not m:
        m = re.search(r'<sheet[^>]*r:id="([^"]+)"[^>]*name="%s"' % re.escape(name), wb)
    if not m:
        raise KeyError("sheet not found: " + name)
    rid = m.group(1)
    t = None
    for rel in re.finditer(r'<Relationship\b[^>]*/?>', rels):
        # attribute order varies by producer — match on the element, not a fixed order
        if re.search(r'Id="%s"' % re.escape(rid), rel.group(0)):
            t = re.search(r'Target="([^"]+)"', rel.group(0)).group(1)
            break
    if t is None:
        raise KeyError("relationship not found: " + rid)
    if t.startswith("/"):
        return t.lstrip("/")
    return "xl/" + t.lstrip("./")

def last_row_num(xml):
    return max(int(x) for x in re.findall(r'<row[^>]*\br="(\d+)"', xml))

def ref_row_styles(xml, rownum, ncols):
    m = re.search(r'(<row[^>]*\br="%d"[^>]*>)(.*?)(</row>)' % rownum, xml, re.S)
    if not m:
        m = re.search(r'<row[^>]*\br="%d"[^>]*/>' % rownum, xml)
        return {}, ""
    body = m.group(2)
    styles = {}
    for c in re.finditer(r'<c\b([^>]*)/?>', body):
        attrs = c.group(1)
        r = re.search(r'r="([A-Z]+)(\d+)"', attrs)
        s = re.search(r's="(\d+)"', attrs)
        if r:
            styles[r.group(1)] = s.group(1) if s else None
    rowattrs = m.group(1)
    return styles, rowattrs

def build_cell(colL, rownum, style, value):
    ref = f'{colL}{rownum}'
    sattr = f' s="{style}"' if style is not None else ""
    if value is None:
        return f'<c r="{ref}"{sattr}/>'
    if isinstance(value, Formula):
        return f'<c r="{ref}"{sattr}><f>{escape(value.text)}</f></c>'
    if isinstance(value, dt.datetime):
        return f'<c r="{ref}"{sattr}><v>{excel_serial(value)}</v></c>'
    if isinstance(value, bool):
        return f'<c r="{ref}"{sattr} t="b"><v>{1 if value else 0}</v></c>'
    if isinstance(value, (int, float)):
        v = repr(value) if isinstance(value, float) else str(value)
        return f'<c r="{ref}"{sattr}><v>{v}</v></c>'
    return f'<c r="{ref}"{sattr} t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>'

class Formula:
    def __init__(self, text):
        self.text = text

def append_rows(path, sheet_name, rows, ncols):
    """rows = list of lists, one per new row, length ncols, cells may be None/str/num/datetime/Formula."""
    tmp = path + ".newtmp"
    with zipfile.ZipFile(path) as z:
        sp = sheet_path(z, sheet_name)
        names = z.namelist()
        data = {n: z.read(n) for n in names}
        infos = {n: z.getinfo(n) for n in names}
    xml = data[sp].decode("utf-8")
    last = last_row_num(xml)
    styles, rowattrs = ref_row_styles(xml, last, ncols)

    out = []
    for i, vals in enumerate(rows):
        rn = last + 1 + i
        cells = []
        for ci in range(1, ncols + 1):
            L = col_letter(ci)
            cells.append(build_cell(L, rn, styles.get(L), vals[ci - 1]))
        newattrs = re.sub(r'\br="\d+"', f'r="{rn}"', rowattrs) if rowattrs else f'<row r="{rn}">'
        newattrs = re.sub(r'\bspans="[^"]*"', f'spans="1:{ncols}"', newattrs)
        out.append(newattrs + "".join(cells) + "</row>")
    newxml = xml.replace("</sheetData>", "".join(out) + "</sheetData>", 1)

    m = re.search(r'<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"/>', newxml)
    if m:
        newxml = newxml.replace(m.group(0),
            f'<dimension ref="{m.group(1)}:{m.group(2)}{last + len(rows)}"/>', 1)
    # force a full recalc on open so the appended formulas and any dependents evaluate
    data[sp] = newxml.encode("utf-8")
    if "xl/workbook.xml" in data:
        wbx = data["xl/workbook.xml"].decode("utf-8")
        if "<calcPr" in wbx:
            wbx = re.sub(r'<calcPr\b[^>]*/>', '<calcPr calcId="0" fullCalcOnLoad="1"/>', wbx, count=1)
        else:
            wbx = wbx.replace("</workbook>", '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>', 1)
        data["xl/workbook.xml"] = wbx.encode("utf-8")

    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:
            zi = zipfile.ZipInfo(n, date_time=infos[n].date_time)
            zi.compress_type = infos[n].compress_type
            zi.external_attr = infos[n].external_attr
            z.writestr(zi, data[n])
    _replace(tmp, path)
    return last + 1, last + len(rows), styles


# --- replace_row -----------------------------------------
def _row_cells(xml, rownum):
    m = re.search(r'<row[^>]*\br="%d"[^>]*>(.*?)</row>' % rownum, xml, re.S)
    if not m:
        return {}
    out = {}
    for c in re.finditer(r'<c\b([^>]*?)(?:/>|>(.*?)</c>)', m.group(1), re.S):
        attrs = c.group(1)
        ref = re.search(r'r="([A-Z]+)\d+"', attrs)
        s = re.search(r'\bs="(\d+)"', attrs)
        t = re.search(r'\bt="([a-zA-Z]+)"', attrs)
        out[ref.group(1)] = (s.group(1) if s else None, t.group(1) if t else None, c.group(2))
    return out

def replace_row(path, sheet_name, rownum, values, refrow, ncols, sst_reuse=True):
    """values: list of ncols cells (None / number / str / datetime / Formula)."""
    tmp = path + ".newtmp"
    with zipfile.ZipFile(path) as z:
        sp = sheet_path(z, sheet_name)
        names = z.namelist()
        data = {n: z.read(n) for n in names}
        infos = {n: z.getinfo(n) for n in names}
    xml = data[sp].decode("utf-8")
    tgt = _row_cells(xml, rownum)
    ref = _row_cells(xml, refrow)
    cells = []
    for ci in range(1, ncols + 1):
        L = col_letter(ci)
        v = values[ci - 1]
        if v is None and L not in tgt and L not in ref:
            continue          # a column neither row carries — don't invent an empty cell
        style = (tgt.get(L) or ref.get(L) or (None, None, None))[0]
        if isinstance(v, str) and sst_reuse and ref.get(L) and ref[L][1] == "s":
            # same literal as the reference row -> reuse its shared-string index
            cells.append('<c r="%s%d"%s t="s">%s</c>' % (
                L, rownum, ' s="%s"' % style if style else "", ref[L][2]))
        else:
            cells.append(build_cell(L, rownum, style, v))
    m = re.search(r'(<row[^>]*\br="%d"[^>]*>)(.*?)(</row>)' % rownum, xml, re.S)
    if not m:
        raise KeyError("row %d not found" % rownum)
    head = re.sub(r'\bspans="[^"]*"', 'spans="1:%d"' % ncols, m.group(1))
    xml = xml[:m.start()] + head + "".join(cells) + "</row>" + xml[m.end():]
    data[sp] = xml.encode("utf-8")
    wbx = data["xl/workbook.xml"].decode("utf-8")
    if "<calcPr" in wbx:
        wbx = re.sub(r'<calcPr\b[^>]*/>', '<calcPr calcId="0" fullCalcOnLoad="1"/>', wbx, count=1)
    else:
        wbx = wbx.replace("</workbook>", '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>', 1)
    data["xl/workbook.xml"] = wbx.encode("utf-8")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:
            zi = zipfile.ZipInfo(n, date_time=infos[n].date_time)
            zi.compress_type = infos[n].compress_type
            zi.external_attr = infos[n].external_attr
            z.writestr(zi, data[n])
    _replace(tmp, path)


# --- set_cells -------------------------------------------
def set_cells(path, sheet_name, cells, style_from_col=None, style_from_row=None):
    """cells: {(row, col): value}.

    style_from_col: column INDEX in the SAME row to copy a missing cell's style from.
    style_from_row: row NUMBER to copy the SAME column's style from — what a new row
    written into a sparse gap needs, since it has no neighbors of its own.
    """
    tmp = path + ".newtmp"
    with zipfile.ZipFile(path) as z:
        sp = sheet_path(z, sheet_name)
        names = z.namelist()
        data = {n: z.read(n) for n in names}
        infos = {n: z.getinfo(n) for n in names}
    xml = data[sp].decode("utf-8")
    for (rn, cn), val in sorted(cells.items()):
        L = col_letter(cn)
        m = re.search(r'(<row[^>]*\br="%d"[^>]*>)(.*?)(</row>)' % rn, xml, re.S)
        if not m:
            # sparse sheets skip empty rows entirely, so a missing row is a gap to fill,
            # not an error. Create it in number order; rows after it keep their numbers,
            # so nothing shifts and no reference moves.
            nxt = None
            for c in re.finditer(r'<row[^>]*\br="(\d+)"', xml):
                if int(c.group(1)) > rn:
                    nxt = c.start(); break
            stub = '<row r="%d">%s</row>' % (rn, "")
            at_pos = nxt if nxt is not None else xml.index("</sheetData>")
            xml = xml[:at_pos] + stub + xml[at_pos:]
            m = re.search(r'(<row[^>]*\br="%d"[^>]*>)(.*?)(</row>)' % rn, xml, re.S)
        body = m.group(2)
        style = None
        own = re.search(r'<c r="%s%d"([^>]*?)(?:/>|>.*?</c>)' % (L, rn), body, re.S)
        if own:
            s = re.search(r'\bs="(\d+)"', own.group(1))
            style = s.group(1) if s else None
        elif style_from_col:
            src = re.search(r'<c r="%s%d"([^>]*?)(?:/>|>.*?</c>)'
                            % (col_letter(style_from_col), rn), body, re.S)
            if src:
                s = re.search(r'\bs="(\d+)"', src.group(1))
                style = s.group(1) if s else None
        elif style_from_row:
            ref = re.search(r'<row[^>]*\br="%d"[^>]*>(.*?)</row>' % style_from_row, xml, re.S)
            if ref:
                src = re.search(r'<c r="%s%d"([^>]*?)(?:/>|>.*?</c>)'
                                % (L, style_from_row), ref.group(1), re.S)
                if src:
                    s = re.search(r'\bs="(\d+)"', src.group(1))
                    style = s.group(1) if s else None
        new = build_cell(L, rn, style, val)
        if own:
            body = body[:own.start()] + new + body[own.end():]
        else:
            # keep cells in column order
            def idx(letters):
                n = 0
                for ch in letters:
                    n = n * 26 + (ord(ch) - 64)
                return n
            pos = len(body)
            for c in re.finditer(r'<c r="([A-Z]+)%d"[^>]*?(?:/>|>.*?</c>)' % rn, body, re.S):
                if idx(c.group(1)) > cn:
                    pos = c.start(); break
            body = body[:pos] + new + body[pos:]
        xml = xml[:m.start()] + m.group(1) + body + m.group(3) + xml[m.end():]
    m = re.search(r'<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"/>', xml)
    if m and cells:
        maxc = max(col_letter(c) for (_, c) in cells)
        def idxL(x):
            n = 0
            for ch in x:
                n = n * 26 + (ord(ch) - 64)
            return n
        if idxL(maxc) > idxL(m.group(2)):
            xml = xml.replace(m.group(0),
                '<dimension ref="%s:%s%s"/>' % (m.group(1), maxc, m.group(3)), 1)
    data[sp] = xml.encode("utf-8")
    wbx = data["xl/workbook.xml"].decode("utf-8")
    if "<calcPr" in wbx:
        wbx = re.sub(r'<calcPr\b[^>]*/>', '<calcPr calcId="0" fullCalcOnLoad="1"/>', wbx, count=1)
    else:
        wbx = wbx.replace("</workbook>", '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>', 1)
    data["xl/workbook.xml"] = wbx.encode("utf-8")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:
            zi = zipfile.ZipInfo(n, date_time=infos[n].date_time)
            zi.compress_type = infos[n].compress_type
            zi.external_attr = infos[n].external_attr
            z.writestr(zi, data[n])
    _replace(tmp, path)


# --- insert_column ---------------------------------------
def cidx(s):
    n = 0
    for ch in s:
        n = n * 26 + (ord(ch) - 64)
    return n

_REF = re.compile(r'(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\dA-Za-z_(])')
_COLRANGE = re.compile(r'(\$?)([A-Z]{1,3}):(\$?)([A-Z]{1,3})(?![\dA-Za-z_(])')

def _segments(f):
    """Split a formula into (is_literal, text) so quoted strings are never touched."""
    out, i, n = [], 0, len(f)
    while i < n:
        j = f.find('"', i)
        if j < 0:
            out.append((False, f[i:])); break
        out.append((False, f[i:j]))
        k = f.find('"', j + 1)
        if k < 0:
            out.append((True, f[j:])); break
        out.append((True, f[j:k + 1])); i = k + 1
    return out

def shift_formula(f, at, delta):
    """Shift unqualified column references >= `at` by `delta`."""
    res = []
    for lit, seg in _segments(f):
        if lit:
            res.append(seg); continue
        def qualified(m):
            # walk back over $ and letters/digits to find a sheet qualifier
            p = m.start()
            if p > 0 and seg[p - 1] == '$':
                p -= 1
            return p > 0 and seg[p - 1] == '!'
        def do_ref(m):
            if qualified(m):
                return m.group(0)
            c = cidx(m.group(2))
            return m.group(1) + (col_letter(c + delta) if c >= at else m.group(2)) + m.group(3) + m.group(4)
        def do_colrange(m):
            if qualified(m):
                return m.group(0)
            c1, c2 = cidx(m.group(2)), cidx(m.group(4))
            return (m.group(1) + (col_letter(c1 + delta) if c1 >= at else m.group(2)) + ":"
                    + m.group(3) + (col_letter(c2 + delta) if c2 >= at else m.group(4)))
        s = _COLRANGE.sub(do_colrange, seg)
        s = _REF.sub(do_ref, s)
        res.append(s)
    return "".join(res)

def _shift_addr(a, at, delta):
    m = re.match(r'([A-Z]+)(\d+)$', a)
    c = cidx(m.group(1))
    return (col_letter(c + delta) if c >= at else m.group(1)) + m.group(2)

def insert_column(path, sheet_name, at, new_cells=None, verify=True):
    """Insert one blank column at index `at` (1-based). new_cells: {row: value_or_Formula}
    written into the new column, taking its style from the column that moved out of it."""
    tmp = path + ".newtmp"
    with zipfile.ZipFile(path) as z:
        sp = sheet_path(z, sheet_name)
        names = z.namelist(); data = {n: z.read(n) for n in names}
        infos = {n: z.getinfo(n) for n in names}
        rels_name = sp.replace("xl/worksheets/", "xl/worksheets/_rels/") + ".rels"
    xml = data[sp].decode("utf-8")

    # --- refuse a shared range that straddles the insert point -----------------
    for m in re.finditer(r'<f [^>]*t="shared"[^>]*ref="([A-Z]+)\d+:([A-Z]+)\d+"', xml):
        c1, c2 = cidx(m.group(1)), cidx(m.group(2))
        if c1 < at <= c2:
            raise ValueError("shared formula range %s straddles the insert column" % m.group(0))

    orig_formulas = re.findall(r'<f\b[^>]*>([^<]*)</f>', xml)

    # --- cells: address + formula ---------------------------------------------
    def do_cell(m):
        head, body = m.group(1), m.group(2)
        head = re.sub(r'r="([A-Z]+\d+)"', lambda a: 'r="%s"' % _shift_addr(a.group(1), at, 1), head)
        return "<c" + head + (">" + body + "</c>" if body is not None else "/>")
    xml = re.sub(r'<c([^>]*?)(?:/>|>(.*?)</c>)', lambda m: do_cell(m), xml, flags=re.S)
    xml = re.sub(r'(<f\b[^>]*ref=")([A-Z]+\d+):([A-Z]+\d+)(")',
                 lambda m: m.group(1) + _shift_addr(m.group(2), at, 1) + ":"
                           + _shift_addr(m.group(3), at, 1) + m.group(4), xml)
    xml = re.sub(r'(<f\b[^>]*>)([^<]*)(</f>)',
                 lambda m: m.group(1) + shift_formula(m.group(2), at, 1) + m.group(3), xml)

    # --- cols, dimension, hyperlinks ------------------------------------------
    def do_col(m):
        mn, mx = int(m.group(1)), int(m.group(2))
        return '<col min="%d" max="%d"' % (mn + 1 if mn >= at else mn, mx + 1 if mx >= at else mx)
    xml = re.sub(r'<col min="(\d+)" max="(\d+)"', do_col, xml)
    # after the shift, `at` may already be covered by a widened range (min stayed
    # left of the insert, max moved right) — only add a definition when it is not
    covered = any(int(m.group(1)) <= at <= int(m.group(2))
                  for m in re.finditer(r'<col min="(\d+)" max="(\d+)"', xml))
    if not covered:
        for m in re.finditer(r'<col min="(\d+)" max="(\d+)"([^>]*)/>', xml):
            if int(m.group(1)) == at + 1:
                xml = xml.replace(m.group(0), '<col min="%d" max="%d"%s/>' % (at, at, m.group(3)) + m.group(0), 1)
                break
    xml = re.sub(r'<dimension ref="([A-Z]+\d+):([A-Z]+)(\d+)"/>',
                 lambda m: '<dimension ref="%s:%s%s"/>' % (m.group(1),
                     col_letter(cidx(m.group(2)) + 1) if cidx(m.group(2)) >= at else m.group(2), m.group(3)), xml)
    xml = re.sub(r'(<hyperlink ref=")([A-Z]+\d+)(")',
                 lambda m: m.group(1) + _shift_addr(m.group(2), at, 1) + m.group(3), xml)

    # --- the round-trip proof --------------------------------------------------
    if verify:
        now = re.findall(r'<f\b[^>]*>([^<]*)</f>', xml)
        assert len(now) == len(orig_formulas), "formula count changed"
        for a, b in zip(orig_formulas, now):
            back = shift_formula(b, at + 1, -1)
            if back != a:
                raise AssertionError("shift is not invertible:\n  was %r\n  now %r\n  back %r" % (a, b, back))

    # --- write the new column --------------------------------------------------
    if new_cells:
        data[sp] = xml.encode("utf-8")
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for n in names:
                zi = zipfile.ZipInfo(n, date_time=infos[n].date_time); zi.compress_type = infos[n].compress_type
                zi.external_attr = infos[n].external_attr; z.writestr(zi, data[n])
        _replace(tmp, path)
        set_cells(path, sheet_name, {(r, at): v for r, v in new_cells.items()}, style_from_col=at + 1)
        return
    data[sp] = xml.encode("utf-8")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:
            zi = zipfile.ZipInfo(n, date_time=infos[n].date_time); zi.compress_type = infos[n].compress_type
            zi.external_attr = infos[n].external_attr; z.writestr(zi, data[n])
    _replace(tmp, path)

def shift_comments(path, comments_part, vml_part, at):
    """Shift comment cell refs and their VML column anchors (VML columns are 0-based)."""
    tmp = path + ".newtmp"
    with zipfile.ZipFile(path) as z:
        names = z.namelist(); data = {n: z.read(n) for n in names}; infos = {n: z.getinfo(n) for n in names}
    if comments_part in data:
        x = data[comments_part].decode("utf-8")
        x = re.sub(r'(<comment ref=")([A-Z]+\d+)(")',
                   lambda m: m.group(1) + _shift_addr(m.group(2), at, 1) + m.group(3), x)
        data[comments_part] = x.encode("utf-8")
    if vml_part in data:
        v = data[vml_part].decode("utf-8")
        v = re.sub(r'<x:Column>(\d+)</x:Column>',
                   lambda m: '<x:Column>%d</x:Column>' % (int(m.group(1)) + 1 if int(m.group(1)) >= at - 1 else int(m.group(1))), v)
        data[vml_part] = v.encode("utf-8")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for n in names:
            zi = zipfile.ZipInfo(n, date_time=infos[n].date_time); zi.compress_type = infos[n].compress_type
            zi.external_attr = infos[n].external_attr; z.writestr(zi, data[n])
    _replace(tmp, path)
