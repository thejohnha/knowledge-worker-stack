#!/usr/bin/env python3
"""One Gmail message -> a PDF.

  gmail_message_to_pdf.py <msg-id> <out.pdf>

Renders the headers and body `g read` prints, then drives the browser's own print engine
(Chromium, else Google Chrome). Gmail's print view would need an authenticated browser session;
this needs nothing but the message, and carries the same content: who sent it, when, the subject,
the body, the attachment names, and the message id so the original can always be found again.
"""
import html, os, subprocess, sys, pathlib, tempfile

BROWSERS = ("/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

def browser():
    for b in BROWSERS:
        if os.access(b, os.X_OK):
            return b
    sys.exit("gmail_message_to_pdf.py: no browser to print with: install Chromium (browser/macos in "
             "knowledge-worker-stack) or Google Chrome into /Applications")

def render(msg_id, out_pdf):
    chrome = browser()
    r = subprocess.run(["g", "read", msg_id], stdout=subprocess.PIPE, text=True)
    if r.returncode:
        sys.exit(f"gmail_message_to_pdf.py: g read {msg_id} failed (exit {r.returncode}); no PDF written")
    head, body = [], []
    seen = False
    for line in r.stdout.splitlines():
        if line.strip() == "---" and not seen:
            seen = True
            continue
        (body if seen else head).append(line)
    fields = {}
    for line in head:
        if ":" in line:
            k, v = line.split(":", 1)
            fields[k.strip()] = v.strip()
    doc = f"""<!doctype html><meta charset=utf-8><style>
      body {{ font: 11pt/1.45 -apple-system, Helvetica, Arial, sans-serif; margin: 0; color:#111; }}
      .hdr {{ border-bottom:2px solid #333; padding-bottom:.6em; margin-bottom:1em; }}
      .subj {{ font-size:15pt; font-weight:700; margin-bottom:.5em; }}
      .f {{ margin:.15em 0; }} .f b {{ display:inline-block; width:4.5em; color:#555; font-weight:600; }}
      pre {{ white-space:pre-wrap; word-wrap:break-word; font: 10.5pt/1.5 inherit; margin:0; }}
      .src {{ margin-top:2em; padding-top:.6em; border-top:1px solid #bbb; color:#666; font-size:8.5pt; }}
    </style>
    <div class=hdr><div class=subj>{html.escape(fields.get('Subject','(no subject)'))}</div>
      <div class=f><b>From</b> {html.escape(fields.get('From',''))}</div>
      <div class=f><b>To</b> {html.escape(fields.get('To',''))}</div>
      <div class=f><b>Date</b> {html.escape(fields.get('Date',''))}</div></div>
    <pre>{html.escape(chr(10).join(body).strip())}</pre>
    <div class=src>Gmail message id {html.escape(msg_id)}</div>"""
    out = pathlib.Path(out_pdf).resolve()
    # The page and a throwaway profile live in a temp folder: nothing beside the PDF is overwritten, and a
    # browser already running on its normal profile (the agent's Chromium) is never touched.
    with tempfile.TemporaryDirectory() as tmp:
        page = pathlib.Path(tmp, "message.html")
        page.write_text(doc, encoding="utf-8")
        p = subprocess.run([chrome, "--headless", "--disable-gpu", "--no-pdf-header-footer",
                            f"--user-data-dir={tmp}/profile", f"--print-to-pdf={out}", page.as_uri()],
                           capture_output=True, text=True)
    if p.returncode or not out.is_file():
        sys.exit(f"gmail_message_to_pdf.py: the browser did not write {out} (exit {p.returncode})")
    return fields.get("Subject", "(no subject)")

if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1].startswith("-"):
        sys.exit(__doc__)
    subj = render(sys.argv[1], sys.argv[2])
    print(f"{sys.argv[2]}  <- {subj}")
