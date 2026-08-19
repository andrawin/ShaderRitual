#!/usr/bin/env python3
"""Generate the Squarespace paste-in snippet from index.html.

index.html is the single source of truth. Run this after editing it:

    python3 build.py

and paste squarespace/code-block.html into a Squarespace Code Block.
"""

import pathlib
import re

HERE = pathlib.Path(__file__).parent
SRC = HERE / "index.html"
OUT = HERE / "squarespace" / "code-block.html"

HEADER = """<!-- =====================================================================
     97KOBOLAB — Squarespace code block.  GENERATED FILE, DO NOT EDIT.
     Source: 97kobolab-site/index.html  ·  regenerate with: python3 build.py

     Paste this whole thing into a Code Block on a blank page.
     Before publishing, replace the logo src below with the URL of the logo
     you uploaded to Squarespace (see README.md).
     ===================================================================== -->

<style>
/* --- Squarespace chrome ---------------------------------------------------
   Hides the template header/footer and strips section padding so the page is
   edge to edge. Delete this block if you want to keep the Squarespace nav. */
#header, .header, header#header,
footer.sections, #footer-sections, .footer-sections { display: none !important; }
#siteWrapper, .site-wrapper, #page, #sections, .page-section,
.content-wrapper, .fluid-engine { padding: 0 !important; margin: 0 !important; max-width: none !important; }
.page-section > .content-wrapper { min-height: 0 !important; }
body, #siteWrapper { background: #0b0d10 !important; }
/* ------------------------------------------------------------------------ */
</style>
"""


def main() -> None:
    html = SRC.read_text(encoding="utf-8")

    fonts = re.findall(r'<link[^>]+fonts\.(?:googleapis|gstatic)[^>]*>', html)
    style = re.search(r'<style>.*?</style>', html, re.S)
    body = re.search(r'<body>(.*?)</body>', html, re.S)

    if not style or not body:
        raise SystemExit("index.html: could not find <style> or <body>")

    parts = [HEADER, *fonts, "", style.group(0), body.group(1).strip(), ""]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(parts), encoding="utf-8")
    print(f"wrote {OUT.relative_to(HERE)}  ({OUT.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
