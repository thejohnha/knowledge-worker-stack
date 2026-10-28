# Excel workbooks without breaking them

Two small tools that let Claude change an `.xlsx` file without losing its formulas, cached results, formats, pivot tables or named ranges, plus the traps that corrupt a workbook when a script edits it the obvious way. Optional; nothing else in this repo needs it.

- **`agent_xlsx_surgery.py`**: edits a workbook by rewriting only the cells it is asked to change, inside the file's own XML. Everything else stays byte for byte as it was. Four operations: append rows, fill an empty pre-styled row, set scattered cells, insert a column (re-pointing every formula, with a built-in proof that the shift is correct). New cells copy a neighbor's style. Standard Python only.
- **`agent_xlsx_formula_cache.py`**: computes the workbook's formulas with the `formulas` engine and prints the results; with `--patch` it writes them into the file as the stored results, leaving the formulas themselves alone. Use it after a surgical edit, so a script reading the file sees numbers instead of blanks, when Excel is not available to recalculate.

## Which to use
| Job | Use |
|:---|:---|
| Read values from a file Excel last saved | `openpyxl` with `data_only=True`, read-only |
| Change a few cells, add rows, insert a column | `agent_xlsx_surgery.py` on a copy |
| Refresh stored results after that, without Excel | `agent_xlsx_formula_cache.py --patch` |
| Restructure with pivots, tables, charts; final numbers | Real Excel through `xlwings` (below) |
| Build a brand-new workbook | `openpyxl`, writing a new file |

## Install
```bash
brew install uv                                  # runs Python packages without installing them anywhere
mkdir -p ~/bin && install -m 644 agent_xlsx_surgery.py ~/bin/ && install -m 755 agent_xlsx_formula_cache.py ~/bin/
grep -q 'HOME/bin' ~/.zshrc 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> ~/.zshrc
```
- Run from this folder. Both files must sit in the same folder: the cache tool imports the surgery module from beside itself.
- Package versions are pinned to the set these tools were tested with. `uv run --python 3.12 --with …` fetches them, and Python 3.12 if missing, into a cache on first use and leaves nothing installed.

## Use
Always on a copy; every operation rewrites the file in place.
```python
# edit.py — run: python3 edit.py   (standard library only)
import os, sys; sys.path.insert(0, os.path.expanduser("~/bin"))
from agent_xlsx_surgery import insert_column, append_rows, set_cells, Formula
f = "copy.xlsx"
insert_column(f, "Data", 3, new_cells={1: "discount", 2: 0.5})      # new column C; old C onward moves right
append_rows(f, "Data", [["r7", 3, None, 2, Formula("B7*D7")]], 5)    # 5 = column count of the new row
set_cells(f, "Data", {(6, 5): Formula("SUM(E2:E4)+E7")})             # (row, column), both 1-based
```
- Formulas are written WITHOUT the leading `=`, the way Excel stores them in the file.
```bash
uv run --python 3.12 --with formulas==1.3.4 --with numpy --with openpyxl==3.1.5 python3 ~/bin/agent_xlsx_formula_cache.py copy.xlsx Data          # print results
uv run --python 3.12 --with formulas==1.3.4 --with numpy --with openpyxl==3.1.5 python3 ~/bin/agent_xlsx_formula_cache.py copy.xlsx Data --patch  # and store them
```
- Anything it lists under `UNEVALUATED` was left without a stored result. Treat that as a stop, not a warning.

## The traps that corrupt workbooks
- **openpyxl load and save** throws away every stored formula result in the whole workbook (a later read sees blanks), and drops pivot tables and some named ranges. Use it to read, or to write a new file; never to save over a workbook that matters.
- **openpyxl `insert_cols`** moves cells but not the references inside formulas: `=B2*C2` stays `=B2*C2` and now points at the wrong column. Nothing errors; the numbers are just wrong. Use `insert_column` here, or Excel.
- **The `formulas` engine is a cross-check, never the source of a number you rely on.** It computes common functions (SUM, VLOOKUP, XLOOKUP, EOMONTH, IFS) correctly, but on a function it cannot handle it can return a wrong or blank value without raising. Check every cell you use was evaluated, stop on any `#REF!`/`#VALUE!`/`#N/A`/`#NAME?`, and re-test when a workbook starts using a new function.
- **Style on existing cells.** `set_cells` copies a neighbor's style only for a cell it has to create. A cell already present in the file, even an empty one, keeps its own style. A batch can come out half formatted while every value is right, so compare formatting as well as values.
- **After a column insert**, delete `xl/calcChain.xml` if present (Excel rebuilds it), call `shift_comments()` if the sheet has comments, and fix by hand any formula on ANOTHER sheet, or any named range, that points into the edited sheet; `insert_column` shifts only the sheet it edits. It refuses a shared formula that spans the insert point.
- **Every surgical write marks the workbook to recalculate fully when Excel next opens it**, so Excel's own numbers replace the patched ones on the next open and save.

## Driving real Excel (xlwings)
Excel itself is the most faithful engine: it re-points references on its own, keeps pivots and tables, and computes every function. On a Mac, `xlwings` drives it over Apple events. Run as `uv run --with xlwings==0.36.5 --with openpyxl==3.1.5 python3 script.py`.
- **One process at a time, in your logged-in desktop session.** Never from parallel or background agents, cron, launchd or ssh: bursts of Apple events multiply permission pop-ups and can crash Excel, and with no desktop session `xw.App()` hangs.
- **Permission is per program.** The macOS Automation grant (System Settings → Privacy & Security → Automation → your terminal → Microsoft Excel) belongs to the program that runs the script, usually your terminal app. A different terminal, or a session restarted under another parent, gets error `-1743` until granted. It cannot be granted from a script.
- **Zero Excel windows open = every change silently does nothing.** Writes report success and the live object echoes back what you set, but nothing reaches the disk. Check first with `osascript -e 'tell application "Microsoft Excel" to return count of windows'`, and verify every write by reopening the file or comparing its checksum. A locked screen does not matter; the window count does.
- **Folder access fails silently.** Excel is sandboxed: writing to a folder it was never granted raises a "Grant Access" picker that can hide behind other windows while the script reports success. Save into `~/Documents`, then move the file with the shell.
- **Text that starts with `=` becomes a formula.** If it names a sheet that does not exist, Excel opens a file picker that blocks every further Apple event until a person clicks Cancel. Prefix such text with `'`.
- **Never run while you have a workbook open in Excel**, and never quit "all Excel": quit only the instance the script started (`app.quit()`), or you lose unsaved work. Check a file is not in use with `lsof <file>` before copying it; a `~$` lock file beside it is only a hint.
- **Mac specifics:** an inserted column arrives empty of formulas, so write them into the new cells with ordinary A1 references (`sht.range("C2").formula = "=B2+C1"`); `formula_r1c1` does not exist on the Mac. Full-column inserts fail with error 1004 when a pivot, table or chart sits at the right edge: grow the table with `table.resize(range)` instead. xlwings on the Mac cannot rebuild pivot caches; set the pivot to refresh on load (`ws._pivots[0].cache.refreshOnLoad = True` through openpyxl) and Excel rebuilds it when the file is next opened.
- **Safe shape for anything that matters:** copy the file, work on the copy, verify the result independently (the formula-cache tool is a good second opinion), have a person review, then save it as a new file.

## Remove it
```bash
rm ~/bin/agent_xlsx_surgery.py ~/bin/agent_xlsx_formula_cache.py
uv cache clean        # optional: drops every package uv has downloaded, for any project
brew uninstall uv     # optional, if nothing else uses it
```

## Known limits
- `insert_column` shifts only the edited sheet's own formulas, hyperlinks, column widths and shared-formula ranges; not other sheets, named ranges, conditional formatting ranges or data validation.
- One column per `insert_column` call; no row insert or delete.
- Dates written by the surgery tool are stored as numbers; give the target cell a date format (or let it copy one from a neighbor).

Tested on macOS 26 in a throwaway folder: a workbook built with openpyxl, stored results filled by `--patch`, then a column insert, a row append and a cell set, which kept every formula correct, the untouched stored results and the cell formats; a second `--patch` computed the new formulas. Also confirmed the openpyxl `insert_cols` trap on the same file. Not tested: opening the edited file in Excel, and the xlwings section (it needs a live Excel; it describes behavior of the setup these tools came from).
